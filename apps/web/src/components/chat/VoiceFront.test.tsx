import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { VoicePanel, type Voice } from "./VoiceFront";
import { formatCallClock } from "./useVoiceFront";

const termSettingsController = {
  data: { config: { terms: [] } },
  update: async () => {},
};
vi.mock("./VoiceSettingsPanel", () => ({
  VoiceSettingsPanel: () => null,
  useVoiceSettings: () => termSettingsController,
}));
vi.mock("../ui/button", () => ({ Button: "button" }));

let root: ReactTestRenderer | undefined;
afterEach(async () => {
  if (root) await act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

function voice(
  transcript: Voice["transcript"],
  bounds: { startedAt?: number; endedAt?: number; active?: boolean } = {},
): Voice {
  return {
    transcript,
    enabled: true,
    active: bounds.active ?? true,
    startedAt: bounds.startedAt,
    endedAt: bounds.endedAt,
    latency: { lastUserAt: undefined, responses: [], transcription: [] },
    sdkMetrics: [],
    muted: false,
    error: "",
    status: "Listening",
    devices: [],
    deviceId: "",
    settingsOpen: false,
    start: async () => {},
    stop: () => {},
    toggleMute: () => {},
    refreshHistory: () => {},
    setDeviceId: () => {},
    toggleSettings: () => {},
  };
}

it("keeps the latest voice message visible on history load, append, transcript revisions and a full buffer", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // Model the panel viewport without opening a browser. React still mounts the
  // real transcript and runs its layout effects after each message update.
  const viewport = { top: 0, height: 120 };
  let latestBottom = 400;
  const options = {
    createNodeMock: () => ({
      scrollIntoView: ({ block }: ScrollIntoViewOptions) => {
        // A growing message can span the entire viewport. "nearest" leaves
        // that element in place, hiding its newest lines; "end" reveals them.
        if (block === "end") viewport.top = Math.max(0, latestBottom - viewport.height);
      },
    }),
  };
  let current = voice([{ id: "user:1", role: "user", content: "Pierwsza wypowiedź" }]);
  await act(() => {
    root = create(<VoicePanel voice={current} threadId="thread" />, options);
  });
  expect(viewport.top + viewport.height).toBeGreaterThanOrEqual(latestBottom);

  latestBottom = 600;
  current = {
    ...current,
    transcript: [
      ...current.transcript,
      { id: "assistant:1", role: "assistant", content: "Odpowiedź" },
    ],
  };
  await act(() => root!.update(<VoicePanel voice={current} threadId="thread" />));
  expect(viewport.top + viewport.height).toBeGreaterThanOrEqual(latestBottom);

  latestBottom = 800;
  current = {
    ...current,
    transcript: current.transcript.map((entry) =>
      entry.role === "user"
        ? {
            ...entry,
            content: "Dłuższa, poprawiona wypowiedź",
          }
        : entry,
    ),
  };
  await act(() => root!.update(<VoicePanel voice={current} threadId="thread" />));
  expect(viewport.top + viewport.height).toBeGreaterThanOrEqual(latestBottom);

  current = {
    ...current,
    transcript: Array.from({ length: 100 }, (_, index) => ({
      id: `user:${index}`,
      role: "user",
      content: "Wypowiedź",
    })),
  };
  await act(() => root!.update(<VoicePanel voice={current} threadId="thread" />));
  viewport.top = 0;
  current = {
    ...current,
    transcript: [
      ...current.transcript.slice(1),
      { id: "user:100", role: "user", content: "Najnowsza" },
    ],
  };
  await act(() => root!.update(<VoicePanel voice={current} threadId="thread" />));
  expect(viewport.top + viewport.height).toBeGreaterThanOrEqual(latestBottom);

  // Reading older messages must not be interrupted by audio/status or settings updates.
  viewport.top = 0;
  current = { ...current, status: "Odpowiadam", muted: true, settingsOpen: true };
  await act(() => root!.update(<VoicePanel voice={current} threadId="thread" />));
  expect(viewport.top).toBe(0);
});

it("keeps resumed speech in one user bubble until the voice replies", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const first = { id: "user:a", role: "user", content: "Sprawdź plik" };
  await act(() => {
    root = create(<VoicePanel voice={voice([first])} threadId="thread" />);
  });
  const resumed = { id: "user:b", role: "user", content: "i dodaj test" };
  await act(() => {
    root!.update(<VoicePanel voice={voice([first, resumed])} threadId="thread" />);
  });
  expect(root!.root.findAllByProps({ children: "You" })).toHaveLength(1);
  expect(root!.root.findAllByProps({ children: "Sprawdź plik i dodaj test" })).toHaveLength(1);
  await act(() => {
    root!.update(
      <VoicePanel
        voice={voice([
          first,
          resumed,
          { id: "assistant:a", role: "assistant", content: "Dobrze" },
          { id: "user:c", role: "user", content: "Jeszcze jedno" },
        ])}
        threadId="thread"
      />,
    );
  });
  expect(root!.root.findAllByProps({ children: "You" })).toHaveLength(2);
});

it("shows a live duration during the call and a session summary after it ends", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const startedAt = Date.now() - 65_000;
  const endedAt = startedAt + 65_000;
  await act(() => {
    root = create(
      <VoicePanel
        voice={voice([{ id: "user:a", role: "user", content: "Cześć" }], { startedAt })}
        threadId="thread"
      />,
      { createNodeMock: () => ({ scrollIntoView: () => {} }) },
    );
  });
  const counter = root!.root.findByProps({ "aria-label": "Call duration" });
  expect(counter.children).toHaveLength(1);
  expect(counter.children[0]).toMatchObject({
    props: { startedAt, endedAt: undefined },
  });
  expect(
    root!.root.findAll((node) => String(node.props.children).startsWith("Call ended at ")).length,
  ).toBe(0);

  await act(() =>
    root!.update(
      <VoicePanel
        voice={voice(
          [
            { id: "user:a", role: "user", content: "Cześć" },
            { id: "assistant:a", role: "assistant", content: "Cześć! Słucham." },
          ],
          { startedAt, endedAt, active: false },
        )}
        threadId="thread"
      />,
    ),
  );
  // A single compact summary line replaces the old bordered section.
  const summary = root!.root.findAll((node) =>
    String(
      Array.isArray(node.props.children)
        ? node.props.children.find((item: unknown) => typeof item === "string")
        : node.props.children,
    ).startsWith("Call ended at "),
  )[0]!;
  expect(summary).toBeDefined();
  expect(JSON.stringify(summary.props.children)).toContain(formatCallClock(startedAt));
  expect(JSON.stringify(summary.props.children)).toContain("1:05");
  // The full transcript stays visible under the summary after the call ends.
  expect(root!.root.findAllByProps({ children: "Cześć" }).length).toBeGreaterThan(0);
});
