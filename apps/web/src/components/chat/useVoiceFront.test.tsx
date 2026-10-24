import { act, useEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { useVoiceFront, formatCallDuration, summarizePipelineStats } from "./useVoiceFront";

let voice: ReturnType<typeof useVoiceFront>;
let root: ReactTestRenderer | undefined;
function Probe({ threadId, panelOpen = true }: { threadId: string; panelOpen?: boolean }) {
  const currentVoice = useVoiceFront(threadId);
  useEffect(() => {
    voice = currentVoice;
  });
  return panelOpen ? <aside>{currentVoice.status}</aside> : null;
}

afterEach(async () => {
  if (root) await act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("refreshes results completed offline without starting a call and keeps history ordered", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), { location: { origin: "https://voice.test" } }),
  );
  const original = { id: "user:1", role: "user", content: "Wykonaj zadanie" };
  const result = { id: "agent:result", role: "assistant", content: "Zadanie gotowe" };
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ messages: [original] }));
  vi.stubGlobal("fetch", fetcher);
  await act(() => {
    root = create(<Probe threadId="thread" />);
  });
  expect(voice.transcript).toEqual([original]);
  fetcher.mockResolvedValueOnce(Response.json({ messages: [original, result] }));
  await act(() => voice.refreshHistory());
  expect(voice.transcript).toEqual([original, result]);
  expect(voice.active).toBe(false);
  fetcher.mockResolvedValueOnce(Response.json({ messages: [original, result] }));
  await act(() => window.dispatchEvent(new Event("focus")));
  expect(voice.transcript).toEqual([original, result]);
});

async function pendingMicrophone() {
  vi.stubEnv("VITE_VOICE_FRONT_ORIGIN", "/voice/");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), { location: { origin: "https://voice.test" } }),
  );
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ messages: [] })));
  vi.stubGlobal(
    "AudioContext",
    class {
      resume = vi.fn().mockResolvedValue(undefined);
      close = vi.fn().mockResolvedValue(undefined);
    },
  );
  let allow!: (stream: MediaStream) => void;
  const permission = new Promise<MediaStream>((resolve) => {
    allow = resolve;
  });
  const trackStop = vi.fn();
  const stream = { getTracks: () => [{ stop: trackStop }] } as unknown as MediaStream;
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: () => permission } });
  await act(() => {
    root = create(<Probe threadId="a" />);
  });
  let connecting!: Promise<void>;
  await act(() => {
    connecting = voice.start();
  });
  return { allow: () => allow(stream), connecting, trackStop };
}

describe("call duration label", () => {
  it("formats mm:ss and h:mm:ss for the live counter and the summary", () => {
    expect(formatCallDuration(0)).toBe("0:00");
    expect(formatCallDuration(65_000)).toBe("1:05");
    expect(formatCallDuration(3_540_000)).toBe("59:00");
    expect(formatCallDuration(3_600_000)).toBe("1:00:00");
  });
  it("never reports a negative duration on clock jitter", () => {
    expect(formatCallDuration(-500)).toBe("0:00");
  });
});

describe("voice connection lifetime", () => {
  it("keeps the pending call alive while its panel is hidden and reopened", async () => {
    const pending = await pendingMicrophone();
    await act(() => root!.update(<Probe threadId="a" panelOpen={false} />));
    expect(voice.active).toBe(true);
    expect(voice.status).toBe("Connecting…");
    await act(() => root!.update(<Probe threadId="a" panelOpen />));
    expect(voice.active).toBe(true);
    // Only an explicit hang-up releases the pending microphone grant.
    await act(() => voice.stop());
    await act(async () => {
      pending.allow();
      await pending.connecting;
    });
    expect(pending.trackStop).toHaveBeenCalledOnce();
    expect(voice.active).toBe(false);
  });
  it("releases a late microphone grant after the user hangs up", async () => {
    const pending = await pendingMicrophone();
    await act(() => voice.stop());
    await act(async () => {
      pending.allow();
      await pending.connecting;
    });
    expect(pending.trackStop).toHaveBeenCalledOnce();
    expect(voice.active).toBe(false);
    expect(voice.error).toBe("");
  });
  it("never carries a pending voice connection into another thread", async () => {
    const pending = await pendingMicrophone();
    await act(() => root!.update(<Probe threadId="b" />));
    await act(async () => {
      pending.allow();
      await pending.connecting;
    });
    expect(pending.trackStop).toHaveBeenCalledOnce();
    expect(voice.active).toBe(false);
    expect(voice.transcript).toEqual([]);
  });
});

describe("pipeline stats", () => {
  it("avg every gateway-measured stage and keeps the client end-to-end response", () => {
    const stats = summarizePipelineStats(
      [
        { type: "eou_metrics", endOfUtteranceDelayMs: 400, transcriptionDelayMs: 900 },
        { type: "stt_metrics", durationMs: 0 },
        {
          type: "llm_metrics",
          ttftMs: 300,
          durationMs: 1200,
          tokensPerSecond: 80,
          cancelled: false,
        },
        { type: "llm_metrics", ttftMs: 500, durationMs: 900, cancelled: true },
        { type: "tts_metrics", ttfbMs: 150, durationMs: 2000, cancelled: false },
        { type: "vad_metrics", idleTimeMs: 5 },
      ],
      [2600, 2000],
    );
    const byLabel = new Map(stats.map((s) => [s.label, s]));
    expect(byLabel.get("End-to-end response")).toMatchObject({ ms: 2300, samples: 2 });
    expect(byLabel.get("End of speech delay")).toMatchObject({ ms: 400, samples: 1 });
    expect(byLabel.get("Transcription")).toMatchObject({ ms: 900, samples: 1 });
    expect(byLabel.get("STT request")).toBeUndefined();
    expect(byLabel.get("LLM first token")).toMatchObject({ ms: 300, samples: 1 });
    expect(byLabel.get("LLM total")).toMatchObject({ ms: 1200, samples: 1 });
    expect(byLabel.get("LLM throughput")).toMatchObject({ ms: 80, unit: "tok/s" });
    expect(byLabel.get("TTS first byte")).toMatchObject({ ms: 150 });
    expect(byLabel.get("Vad")).toBeUndefined();
  });
});

it("does not resurrect messages removed by server retention on refresh", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), { location: { origin: "https://voice.test" } }),
  );
  const old = Array.from({ length: 100 }, (_, i) => ({
    id: String(i),
    role: "assistant",
    content: String(i),
  }));
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ messages: old }));
  vi.stubGlobal("fetch", fetcher);
  await act(() => {
    root = create(<Probe threadId="thread" />);
  });
  const server = [...old.slice(1), { id: "100", role: "assistant", content: "new" }];
  fetcher.mockResolvedValueOnce(Response.json({ messages: server }));
  await act(() => voice.refreshHistory());
  expect(voice.transcript).toEqual(server);
  fetcher.mockResolvedValueOnce(Response.json({ messages: [] }));
  await act(() => voice.refreshHistory());
  expect(voice.transcript).toEqual([]);
});

it("ignores an older refresh even when fetch does not honor its abort signal", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), { location: { origin: "https://voice.test" } }),
  );
  let respond!: (response: Response) => void;
  const fetcher = vi.fn().mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        respond = resolve;
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  await act(() => {
    root = create(<Probe threadId="thread" />);
  });
  const message = { id: "latest", role: "assistant", content: "latest" };
  fetcher.mockResolvedValueOnce(Response.json({ messages: [message] }));
  await act(() => voice.refreshHistory());
  await act(() => respond(Response.json({ messages: [] })));
  expect(voice.transcript).toEqual([message]);
});
