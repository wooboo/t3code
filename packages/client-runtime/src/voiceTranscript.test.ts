import { expect, it } from "vite-plus/test";
import {
  applyTermReplacements,
  groupVoiceTranscript,
  type VoiceTermReplacement,
} from "./voiceTranscript";

it("appends new VAD items to a stable bubble until an assistant reply", () => {
  const first = { id: "user:a", role: "user", content: "Sprawdź plik" };
  const resumed = { id: "user:b", role: "user", content: "i dodaj test" };
  expect(groupVoiceTranscript([first, resumed])).toEqual([
    {
      id: first.id,
      role: "user",
      content: "Sprawdź plik i dodaj test",
      entries: [first, resumed],
    },
  ]);
  const reply = { id: "assistant:a", role: "assistant", content: "Dobrze" };
  const next = { id: "user:c", role: "user", content: "Jeszcze jedno" };
  expect(groupVoiceTranscript([first, resumed, reply, next]).map((group) => group.id)).toEqual([
    "user:a",
    "assistant:a",
    "user:c",
  ]);
});

it("recomputes corrections without dropping segment identities or repeated words", () => {
  const first = { id: "user:a", role: "user", content: "Tak", raw: "tak" };
  const second = { id: "user:b", role: "user", content: "tak" };
  const groups = groupVoiceTranscript([first, second]);
  expect(groups[0]?.content).toBe("Tak tak");
  expect(groups[0]?.entries[0]).toBe(first);
  expect(groupVoiceTranscript([first, { ...second, content: "dodaj test" }])[0]?.content).toBe(
    "Tak dodaj test",
  );
  expect(groups[0]?.content).toBe("Tak tak");
});

it("replaces cumulative snapshots across repeated pauses instead of growing duplicate prefixes", () => {
  const snapshots = [
    "Sprawdź plik",
    "Sprawdź plik i dodaj test",
    "Sprawdź plik i dodaj test regresji",
    "Sprawdź plik i dodaj test regresji",
    "Sprawdź plik i dodaj test regresji. Potem uruchom testy.",
  ];
  const entries = snapshots.map((content, index) => ({
    id: `user:${index}`,
    role: "user",
    content,
  }));
  for (let count = 1; count <= entries.length; count++) {
    const groups = groupVoiceTranscript(entries.slice(0, count));
    expect(groups).toHaveLength(1);
    expect(groups[0]?.id).toBe("user:0");
    expect(groups[0]?.content).toBe(snapshots[count - 1]);
    expect(groups[0]?.entries).toEqual(entries.slice(0, count));
  }
});

it("combines incremental fragments and subsequent cumulative snapshots", () => {
  const entries = ["Sprawdź plik", "i dodaj test", "Sprawdź plik i dodaj test regresji"].map(
    (content, index) => ({ id: `user:${index}`, role: "user", content }),
  );
  expect(groupVoiceTranscript(entries)[0]?.content).toBe("Sprawdź plik i dodaj test regresji");
});

it("does not treat partial words or a new exchange as cumulative continuation", () => {
  const entries = [
    { id: "user:a", role: "user", content: "ma" },
    { id: "user:b", role: "user", content: "masło" },
    { id: "assistant:a", role: "assistant", content: "Dobrze" },
    { id: "user:c", role: "user", content: "ma masło i chleb" },
  ];
  expect(groupVoiceTranscript(entries).map((group) => group.content)).toEqual([
    "ma masło",
    "Dobrze",
    "ma masło i chleb",
  ]);
});

it("rewrites misconverted phrases for the displayed transcript", () => {
  const terms: VoiceTermReplacement[] = [
    { from: "kioxia zawsze", to: "KIOXIA zawsze" },
    { from: "kioxia", to: "KIOXIA" },
  ];
  expect(applyTermReplacements("z komentarzem: kioxia zawsze", terms)).toBe(
    "z komentarzem: KIOXIA zawsze",
  );
  expect(applyTermReplacements("serio kioxia", terms)).toBe("serio KIOXIA");
  expect(applyTermReplacements("nic", [])).toBe("nic");
});
