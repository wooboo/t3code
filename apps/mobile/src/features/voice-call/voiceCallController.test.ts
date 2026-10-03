import { describe, expect, it, vi } from "vite-plus/test";
import {
  VoiceCallController,
  voiceGatewayUrl,
  type VoiceAudioPort,
  type VoiceSocket,
} from "./voiceCallController";

function setup(permission: Promise<boolean> = Promise.resolve(true)) {
  const listeners = new Map<string, (event: never) => void>();
  const audio = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    setMuted: vi.fn().mockResolvedValue(undefined),
    setAudioRoute: vi.fn().mockResolvedValue(undefined),
    enqueueAudio: vi.fn().mockResolvedValue(undefined),
    finishResponse: vi.fn().mockResolvedValue(undefined),
    clearPlayback: vi.fn().mockResolvedValue(undefined),
    addListener: (name: string, fn: (event: never) => void) => {
      listeners.set(name, fn);
      return { remove: () => listeners.delete(name) };
    },
  };
  const socket: VoiceSocket = {
    readyState: 1,
    bufferedAmount: 0,
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send: vi.fn(),
    close: vi.fn(),
  };
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ sessionId: "bound-session" }));
  const connect = vi.fn(() => socket);
  const onAudioRoute = vi.fn();
  const onChange = vi.fn();
  const controller = new VoiceCallController({
    baseUrl: "https://t3.test",
    threadId: "thread-a",
    bearerToken: "test-token",
    audio: audio as VoiceAudioPort,
    requestPermission: () => permission,
    fetch: fetchMock,
    connect,
    onChange,
    onAudioRoute,
  });
  return { controller, audio, socket, fetchMock, connect, listeners, onAudioRoute, onChange };
}

describe("native voice call", () => {
  it("updates the same bubble when a paused utterance resumes with a cumulative transcript", async () => {
    const test = setup();
    try {
      await test.controller.start();
      const received = new Promise<void>((resolve) => {
        test.onChange.mockImplementation(() => {
          if (test.controller.state.messages.length === 2) resolve();
        });
      });
      for (const [turnId, content] of [
        ["utterance-a", "Sprawdź ten plik"],
        ["utterance-a", "Sprawdź ten plik i dodaj test"],
        ["utterance-b", "Sprawdź ten plik ponownie"],
      ]) {
        test.socket.onmessage?.({
          data: JSON.stringify({ type: "transcript.final", role: "user", turnId, content }),
        });
      }
      await received;
      expect(test.controller.state.messages.map(({ id, content }) => ({ id, content }))).toEqual([
        { id: "user:utterance-a", content: "Sprawdź ten plik i dodaj test" },
        { id: "user:utterance-b", content: "Sprawdź ten plik ponownie" },
      ]);
    } finally {
      test.controller.stop();
    }
  });

  it("never connects after permission resolves for a stopped call", async () => {
    let resolve!: (granted: boolean) => void;
    const test = setup(
      new Promise<boolean>((done) => {
        resolve = done;
      }),
    );
    const pending = test.controller.start();
    test.controller.stop();
    resolve(true);
    await pending;
    expect(test.fetchMock).not.toHaveBeenCalled();
    expect(test.audio.start).not.toHaveBeenCalled();
    expect(test.controller.state.active).toBe(false);
  });

  it("binds the current thread and authenticates without placing credentials in URLs", async () => {
    const test = setup();
    try {
      await test.controller.start();
      const [url, options] = test.fetchMock.mock.calls[0]!;
      expect(String(url)).toBe("https://t3.test/voice/t3-connect?thread=thread-a&format=json");
      expect(options.headers.Authorization).toBe("Bearer test-token");
      expect(test.connect).toHaveBeenCalledWith(
        "wss://t3.test/voice/api/realtime?thread=thread-a&sessionId=bound-session",
        { Authorization: "Bearer test-token" },
      );
      test.socket.onopen?.();
      expect(JSON.parse(vi.mocked(test.socket.send).mock.calls[0]![0])).toMatchObject({
        type: "connect",
        voiceEnabled: true,
      });
    } finally {
      test.controller.stop();
    }
  });

  it("removes native listeners and closes transport on hangup", async () => {
    const test = setup();
    await test.controller.start();
    expect(test.listeners.size).toBe(4);
    test.controller.stop();
    expect(test.listeners.size).toBe(0);
    expect(test.socket.close).toHaveBeenCalledOnce();
    expect(test.socket.onmessage).toBeNull();
    expect(test.audio.stop).toHaveBeenCalledOnce();
  });

  it("reports and selects native communication routes during a call", async () => {
    const test = setup();
    try {
      await test.controller.start();
      test.listeners.get("route")?.({
        available: ["earpiece", "speaker"],
        selected: "earpiece",
      } as never);
      expect(test.onAudioRoute).toHaveBeenCalledWith(["earpiece", "speaker"], "earpiece");
      await test.controller.setAudioRoute("speaker");
      expect(test.audio.setAudioRoute).toHaveBeenCalledWith("speaker");
    } finally {
      test.controller.stop();
    }
  });

  it("denied microphone permission never opens the gateway", async () => {
    const test = setup(Promise.resolve(false));
    await test.controller.start();
    expect(test.controller.state.error).toContain("mikrofonu");
    expect(test.controller.state.active).toBe(false);
    expect(test.connect).not.toHaveBeenCalled();
  });

  it("forwards playback receipts and drops capture while socket is backed up", async () => {
    const test = setup();
    try {
      await test.controller.start();
      test.listeners.get("playback")?.({ type: "playback.ended", responseId: "r1" } as never);
      expect(test.socket.send).toHaveBeenCalledWith(
        JSON.stringify({ type: "playback.ended", responseId: "r1" }),
      );
      test.socket.bufferedAmount = 128000;
      vi.mocked(test.socket.send).mockClear();
      test.listeners.get("pcm")?.({ audio: "AAA=" } as never);
      expect(test.socket.send).not.toHaveBeenCalled();
    } finally {
      test.controller.stop();
    }
  });

  it("sends capture when React Native does not expose bufferedAmount", async () => {
    const test = setup();
    Reflect.deleteProperty(test.socket, "bufferedAmount");
    try {
      await test.controller.start();
      test.listeners.get("pcm")?.({ audio: "AAA=" } as never);
      expect(test.socket.send).toHaveBeenCalledWith(
        JSON.stringify({ type: "audio.append", audio: "AAA=" }),
      );
      vi.mocked(test.socket.send).mockClear();
      test.socket.readyState = 3;
      test.listeners.get("pcm")?.({ audio: "AAA=" } as never);
      expect(test.socket.send).not.toHaveBeenCalled();
    } finally {
      test.controller.stop();
    }
  });

  it("requires HTTPS and preserves a deployment base path", () => {
    expect(() => voiceGatewayUrl("http://host", "t3-connect", "a")).toThrow("HTTPS");
    expect(voiceGatewayUrl("https://host/t3/", "t3-history", "a").pathname).toBe(
      "/t3/voice/t3-history",
    );
  });

  it("ignores a late binding response after hangup", async () => {
    const test = setup();
    let finish!: (response: Response) => void;
    let requested!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      requested = resolve;
    });
    test.fetchMock.mockImplementation(() => {
      requested();
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    });
    const pending = test.controller.start();
    await requestStarted;
    test.controller.stop();
    finish(Response.json({ sessionId: "old-thread-session" }));
    await pending;
    expect(test.connect).not.toHaveBeenCalled();
  });

  it("starts audio only after gateway readiness and preserves audio event order", async () => {
    const test = setup();
    let audioStarted!: () => void;
    let releaseAudio!: () => void;
    const startReceipt = new Promise<void>((resolve) => {
      audioStarted = resolve;
    });
    const audioReady = new Promise<void>((resolve) => {
      releaseAudio = resolve;
    });
    test.audio.start.mockImplementation(() => {
      audioStarted();
      return audioReady;
    });
    let queued!: () => void;
    const queuedReceipt = new Promise<void>((resolve) => {
      queued = resolve;
    });
    test.audio.enqueueAudio.mockImplementation(async () => {
      queued();
    });
    try {
      await test.controller.start();
      expect(test.audio.start).not.toHaveBeenCalled();
      test.socket.onmessage?.({
        data: JSON.stringify({
          type: "voice.ready",
          inputSampleRate: 16000,
          outputSampleRate: 24000,
        }),
      });
      test.socket.onmessage?.({
        data: JSON.stringify({ type: "audio.delta", audio: "AAA=", responseId: "r" }),
      });
      await startReceipt;
      expect(test.audio.enqueueAudio).not.toHaveBeenCalled();
      releaseAudio();
      await queuedReceipt;
      expect(test.audio.start).toHaveBeenCalledWith({
        inputSampleRate: 16000,
        outputSampleRate: 24000,
      });
      expect(test.audio.enqueueAudio).toHaveBeenCalledWith({ pcmBase64: "AAA=", responseId: "r" });
    } finally {
      test.controller.stop();
    }
  });
});
