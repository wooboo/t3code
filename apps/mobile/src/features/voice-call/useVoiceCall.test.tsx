vi.mock("./callbackDevice", () => ({ registerCallbackDevice: vi.fn(async () => {}) }));
import { act, useEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import * as Option from "effect/Option";
import { EnvironmentId } from "@t3tools/contracts";

const mocks = vi.hoisted(() => ({
  voiceEnabled: undefined as boolean | undefined,
  prepared: {} as { value?: unknown },
  routeListener: undefined as
    | undefined
    | ((state: { available: string[]; selected: string | null }) => void),
  stopListener: undefined as undefined | (() => void),
  routeRemove: vi.fn(),
  outputs: ["speaker", "bluetooth"],
  selectOutput: vi.fn().mockResolvedValue(undefined),
  startCallService: vi.fn().mockResolvedValue(undefined),
  stopCallService: vi.fn().mockResolvedValue(undefined),
  setCallMuted: vi.fn().mockResolvedValue(undefined),
  routeState: {
    available: ["speaker", "earpiece", "bluetooth"],
    selected: "bluetooth" as string | null,
  },
  disconnect: vi.fn().mockResolvedValue(undefined),
  audio: {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    addListener: vi.fn(() => ({ remove: vi.fn() })),
  },
}));
vi.mock("../../native/voiceAudio", () => ({
  getVoiceAudio: () => ({
    startCallService: mocks.startCallService,
    stopCallService: mocks.stopCallService,
    setCallMuted: mocks.setCallMuted,
    getAudioRouteState: async () => mocks.routeState,
    addListener: (_event: string, listener: typeof mocks.routeListener) => {
      if (_event === "audioRouteChanged") mocks.routeListener = listener;
      if (_event === "callStopRequested") mocks.stopListener = listener as () => void;
      return { remove: mocks.routeRemove };
    },
  }),
}));
vi.mock("./useVoiceHost", () => ({ useVoiceHost: () => ({ environmentId: null }) }));
vi.mock("../../state/entities", () => ({
  useServerConfigs: () =>
    new Map([
      [EnvironmentId.make("env"), { environment: { capabilities: { voice: mocks.voiceEnabled } } }],
    ]),
}));
vi.mock("../../state/session", () => ({
  usePreparedConnection: () => mocks.prepared.value,
}));
vi.mock("@livekit/react-native", () => ({
  AudioSession: {
    startAudioSession: mocks.audio.start,
    stopAudioSession: mocks.audio.stop,
    getAudioOutputs: async () => mocks.outputs,
    selectAudioOutput: mocks.selectOutput,
  },
}));
vi.mock("livekit-client", () => ({
  RoomEvent: {
    DataReceived: "data",
    Disconnected: "disconnected",
    Reconnecting: "reconnecting",
    Reconnected: "reconnected",
    ActiveSpeakersChanged: "speakers",
  },
  Room: class {
    on = vi.fn();
    removeAllListeners = vi.fn();
    connect = vi.fn().mockResolvedValue(undefined);
    disconnect = mocks.disconnect;
    localParticipant = {
      setMicrophoneEnabled: vi.fn().mockResolvedValue(undefined),
      audioLevel: 0,
    };
  },
}));
vi.mock("react-native", () => ({
  AppState: { addEventListener: () => ({ remove: vi.fn() }) },
  Platform: { OS: "android", Version: 30 },
  PermissionsAndroid: {
    request: async () => "granted",
    PERMISSIONS: { RECORD_AUDIO: "microphone" },
    RESULTS: { GRANTED: "granted" },
  },
}));
vi.mock("react-native-reanimated", async () => {
  const { useRef } = await import("react");
  return { useSharedValue: (value: number) => useRef({ value }).current };
});
vi.mock("@react-navigation/native", async () => {
  const { useEffect } = await import("react");
  return { useFocusEffect: (effect: () => void) => useEffect(effect, [effect]) };
});
import { useVoiceCall } from "./useVoiceCall";

const connection = {
  httpBaseUrl: "https://t3.test",
  httpAuthorization: { _tag: "Bearer", token: "test" },
};
let voice: ReturnType<typeof useVoiceCall>;
let root: ReactTestRenderer | undefined;
function Probe({
  threadId = "a",
  environmentId = "env",
}: {
  threadId?: string;
  environmentId?: string;
}) {
  const currentVoice = useVoiceCall({ environmentId: EnvironmentId.make(environmentId), threadId });
  useEffect(() => {
    voice = currentVoice;
  });
  return null;
}
afterEach(async () => {
  await act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
  mocks.voiceEnabled = undefined;
  mocks.outputs = ["speaker", "bluetooth"];
  vi.clearAllMocks();
});
it.each(["navigation", "environment", "hangup", "credentials"])(
  "keeps the LiveKit room through wake-up reconnect and still handles %s",
  async (ending) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    mocks.prepared.value = Option.some(connection);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ id: "bound", url: "wss://voice.test", token: "test", messages: [] }),
      ),
    );
    const close = mocks.disconnect;
    await act(() => {
      root = create(<Probe />);
    });
    await act(async () => {
      await voice.start();
    });
    expect(voice.state.status).toBe("Listening");
    expect(mocks.audio.start).toHaveBeenCalledOnce();
    expect(mocks.startCallService).toHaveBeenCalledOnce();
    expect(mocks.startCallService.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.audio.start.mock.invocationCallOrder[0]!,
    );
    expect(voice.state.active).toBe(true);
    mocks.audio.stop.mockClear();
    mocks.stopCallService.mockClear();

    // The supervisor clears prepared while replacing the main T3 connection.
    mocks.prepared.value = Option.none();
    await act(() => root!.update(<Probe />));
    expect(voice.state.active).toBe(true);
    expect(close).not.toHaveBeenCalled();
    expect(mocks.audio.stop).not.toHaveBeenCalled();
    expect(mocks.stopCallService).not.toHaveBeenCalled();

    mocks.prepared.value = Option.some({ ...connection });
    await act(() => root!.update(<Probe />));
    expect(voice.state.active).toBe(true);
    expect(close).not.toHaveBeenCalled();

    await act(() => {
      if (ending === "hangup") voice.stop();
      else if (ending === "credentials") {
        mocks.prepared.value = Option.some({
          ...connection,
          httpAuthorization: { _tag: "Bearer", token: "new" },
        });
        root!.update(<Probe />);
      } else {
        mocks.prepared.value = Option.none();
        root!.update(
          ending === "environment" ? <Probe environmentId="other" /> : <Probe threadId="b" />,
        );
      }
    });
    expect(close).toHaveBeenCalledOnce();
    expect(voice.state.active).toBe(false);
  },
);

it("tracks the actual output at start, on system changes, and after a selection request", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.prepared.value = Option.some(connection);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        id: "bound",
        url: "wss://voice.test",
        token: "test",
        messages: [],
      }),
    ),
  );
  await act(() => {
    root = create(<Probe />);
  });
  await act(async () => {
    await voice.start();
  });
  expect(voice.audioRoute).toBe("bluetooth");
  expect(voice.audioRoutes).toEqual(["speaker", "bluetooth"]);
  await expect(voice.setAudioRoute("earpiece")).rejects.toThrow("unavailable");
  expect(mocks.selectOutput).not.toHaveBeenCalled();
  await act(async () => {
    await voice.setAudioRoute("speaker");
  });
  // A request is not confirmation that Android has changed the output.
  expect(voice.audioRoute).toBe("bluetooth");
  mocks.outputs = ["speaker", "earpiece"];
  await act(() => {
    mocks.routeListener?.({ available: ["speaker", "earpiece"], selected: "speaker" });
  });
  expect(voice.audioRoute).toBe("speaker");
  expect(voice.audioRoutes).toEqual(["speaker", "earpiece"]);
  mocks.outputs = ["headset", "speaker"];
  await act(() => {
    mocks.routeListener?.({ available: ["headset", "speaker"], selected: "headset" });
  });
  expect(voice.audioRoute).toBe("headset");
  await act(() => {
    mocks.routeListener?.({ available: ["speaker"], selected: null });
  });
  expect(voice.audioRoute).toBeNull();
  await act(() => root?.unmount());
  root = undefined;
  expect(mocks.routeRemove).toHaveBeenCalled();
});

it("ends the room and foreground protection from the notification", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.prepared.value = Option.some(connection);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        id: "bound",
        url: "wss://voice.test",
        token: "test",
        messages: [],
      }),
    ),
  );
  await act(() => {
    root = create(<Probe />);
  });
  await act(async () => {
    await voice.start();
  });
  await act(async () => {
    await voice.toggleMute();
  });
  expect(mocks.setCallMuted).toHaveBeenLastCalledWith(true);
  expect(mocks.stopCallService).not.toHaveBeenCalled();
  await act(() => {
    mocks.stopListener?.();
  });
  expect(voice.state.active).toBe(false);
  expect(mocks.disconnect).toHaveBeenCalledOnce();
  expect(mocks.stopCallService).toHaveBeenCalledOnce();
});

it("does not publish microphone audio if foreground protection cannot start", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.prepared.value = Option.some(connection);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ messages: [] })),
  );
  mocks.startCallService.mockRejectedValueOnce(new Error("background start denied"));
  await act(() => {
    root = create(<Probe />);
  });
  await act(async () => {
    await voice.start();
  });
  expect(voice.state.active).toBe(false);
  expect(voice.state.error).toBe("background start denied");
  expect(mocks.audio.start).not.toHaveBeenCalled();
  expect(mocks.stopCallService).toHaveBeenCalledOnce();
});

it("does not start a call on an environment that advertises no voice support", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.prepared.value = Option.some(connection);
  mocks.voiceEnabled = false;
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await act(() => {
    root = create(<Probe />);
  });
  expect(voice.supported).toBe(false);
  expect(voice.unsupportedReason).toContain("Ustawienia");
  await act(async () => {
    await voice.start();
  });
  expect(fetch).not.toHaveBeenCalled();
  expect(mocks.audio.start).not.toHaveBeenCalled();
});
