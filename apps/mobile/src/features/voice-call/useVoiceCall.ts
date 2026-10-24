import { registerCallbackDevice } from "./callbackDevice";
import { getVoiceAudio } from "../../native/voiceAudio";
import { useVoiceHost } from "./useVoiceHost";
import * as Option from "effect/Option";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, PermissionsAndroid, Platform } from "react-native";
import { useSharedValue, type SharedValue } from "react-native-reanimated";
import { type VoiceAudioRoute, type VoiceCallState } from "./voiceCallController";
import { useFocusEffect } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import { AudioSession } from "@livekit/react-native";
import { LivekitCallController } from "./livekitCallController";
import { useServerConfigs } from "../../state/entities";
import { usePreparedConnection } from "../../state/session";

export type VoiceCallHandle = {
  environmentId: EnvironmentId;
  hostEnvironmentId: EnvironmentId;
  state: VoiceCallState;
  audioLevel: SharedValue<number>;
  audioRoutes: VoiceAudioRoute[];
  audioRoute: VoiceAudioRoute | null;
  supported: boolean;
  unsupportedReason: string | null;
  start: () => Promise<void> | undefined;
  stop: () => void;
  refreshHistory: () => void;
  toggleMute: () => Promise<void> | undefined;
  setAudioRoute: (route: VoiceAudioRoute) => Promise<void>;
};

export function useVoiceCall(input: {
  environmentId: EnvironmentId;
  threadId: string;
  hostEnvironmentId?: EnvironmentId;
  callbackId?: string;
}): VoiceCallHandle {
  const voiceHost = useVoiceHost();
  const hostEnvironmentId =
    input.hostEnvironmentId ?? voiceHost.environmentId ?? input.environmentId;
  const prepared = usePreparedConnection(hostEnvironmentId);
  const [state, setState] = useState<VoiceCallState>({
    active: false,
    muted: false,
    status: "Ready for a call",
    error: "",
    messages: [],
  });
  const [callConnection, setCallConnection] = useState<{
    hostEnvironmentId: EnvironmentId;
    environmentId: EnvironmentId;
    threadId: string;
    prepared: typeof prepared;
  } | null>(null);
  // The main T3 transport clears its prepared connection during wake-up reconnects.
  // The independent voice socket can keep using the active call's binding.
  const effectivePrepared =
    Option.isNone(prepared) &&
    state.active &&
    callConnection?.hostEnvironmentId === hostEnvironmentId &&
    callConnection.environmentId === input.environmentId &&
    callConnection.threadId === input.threadId
      ? callConnection.prepared
      : prepared;
  const connection = Option.isSome(effectivePrepared) ? effectivePrepared.value : null;
  const baseUrl = connection?.httpBaseUrl ?? null;
  const bearerToken =
    connection?.httpAuthorization?._tag === "Bearer" ? connection.httpAuthorization.token : null;
  const eligible =
    (Platform.OS === "android" || Platform.OS === "ios") &&
    baseUrl?.startsWith("https://") === true &&
    bearerToken !== null;
  const configs = useServerConfigs();
  const hostHasVoice = configs.get(hostEnvironmentId)?.environment.capabilities.voice;
  const supported = eligible && hostHasVoice !== false;
  const audioLevel = useSharedValue(0);
  const [audioRoutes, setAudioRoutes] = useState<VoiceAudioRoute[]>([]);
  const [audioRoute, setAudioRoute] = useState<VoiceAudioRoute | null>(null);
  const controllerRef = useRef<LivekitCallController | null>(null);
  const requestPermission = useCallback(async () => {
    if (Platform.OS !== "android") return true;
    const mic = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
    if (Number(Platform.Version) >= 31) {
      try {
        // Android 12+ requires this before communication devices can include Bluetooth.
        // A denial must not prevent earpiece or speakerphone calls.
        await PermissionsAndroid.request("android.permission.BLUETOOTH_CONNECT");
      } catch {
        /* Bluetooth remains unavailable; phone audio still works. */
      }
    }
    if (Number(Platform.Version) >= 33) {
      try {
        await PermissionsAndroid.request("android.permission.POST_NOTIFICATIONS");
      } catch {
        /* best effort */
      }
    }
    return mic === PermissionsAndroid.RESULTS.GRANTED;
  }, []);
  useEffect(() => {
    controllerRef.current?.stop();
    audioLevel.value = 0;
    controllerRef.current = null;
    setAudioRoutes([]);
    setAudioRoute(null);
    setState({ active: false, muted: false, status: "Ready for a call", error: "", messages: [] });
    if (!supported || baseUrl === null || bearerToken === null) return;
    let disposed = false;
    const lifecycleAbort = new AbortController();
    const nativeAudio = getVoiceAudio();
    let routeRevision = 0;
    const applyRoute = (snapshot: {
      available: VoiceAudioRoute[];
      selected: VoiceAudioRoute | null;
    }) => {
      if (disposed) return;
      // LiveKit owns routing; Android also lists devices LiveKit cannot select.
      const revision = ++routeRevision;
      void AudioSession.getAudioOutputs()
        .then((outputs) => {
          if (disposed || revision !== routeRevision) return;
          setAudioRoutes(snapshot.available.filter((route) => outputs.includes(route)));
        })
        .catch(() => {
          if (!disposed && revision === routeRevision) setAudioRoutes([]);
        });
      setAudioRoute(snapshot.selected);
    };
    const routeSubscription = nativeAudio?.getAudioRouteState
      ? nativeAudio.addListener("audioRouteChanged", (snapshot) => {
          applyRoute(snapshot);
        })
      : null;
    const controller = new LivekitCallController({
      baseUrl,
      threadId: input.threadId,
      callbackId: input.callbackId,
      environmentId: input.environmentId,
      bearerToken,
      fetch: globalThis.fetch,
      startAudio: async () => {
        if (!(await requestPermission())) throw Error("Allow microphone access.");
        if (Platform.OS === "android") {
          if (!nativeAudio?.startCallService)
            throw Error("Update the app to enable background voice calls.");
          await nativeAudio.startCallService();
        }
        await AudioSession.startAudioSession();
        // Refresh an existing UnifiedPush registration without interrupting an outgoing call.
        void registerCallbackDevice(baseUrl, bearerToken, hostEnvironmentId).catch(() => undefined);
        if (nativeAudio?.getAudioRouteState) {
          const revision = routeRevision;
          const snapshot = await nativeAudio.getAudioRouteState();
          if (revision === routeRevision) applyRoute(snapshot);
        } else {
          const outputs = await AudioSession.getAudioOutputs();
          const routes = outputs.filter((output): output is VoiceAudioRoute =>
            ["earpiece", "speaker", "bluetooth", "headset", "default"].includes(output),
          );
          if (outputs.includes("force_speaker")) routes.push("speaker");
          if (!disposed) {
            setAudioRoutes([...new Set(routes)]);
            setAudioRoute(null);
          }
        }
      },
      stopAudio: async () => {
        try {
          await AudioSession.stopAudioSession();
        } finally {
          await nativeAudio?.stopCallService?.();
        }
      },
      onAudioLevel: (level) => {
        if (!disposed) audioLevel.value = level;
      },
      onChange: (next) => {
        if (!disposed) setState(next);
      },
    });
    const stopSubscription = nativeAudio?.startCallService
      ? nativeAudio.addListener("callStopRequested", () => {
          void controller.stop();
        })
      : null;
    controllerRef.current = controller;
    void controller.loadHistory(lifecycleAbort.signal).catch(() => undefined);
    const foregroundSubscription = AppState.addEventListener("change", (state) => {
      if (state === "active")
        void controller.loadHistory(lifecycleAbort.signal).catch(() => undefined);
    });
    return () => {
      disposed = true;
      foregroundSubscription.remove();
      routeSubscription?.remove();
      stopSubscription?.remove();
      lifecycleAbort.abort();
      controller.stop();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [
    audioLevel,
    baseUrl,
    bearerToken,
    input.environmentId,
    hostEnvironmentId,
    input.threadId,
    input.callbackId,
    requestPermission,
    supported,
  ]);
  useFocusEffect(
    useCallback(
      () => () => {
        controllerRef.current?.stop();
      },
      [],
    ),
  );
  return {
    refreshHistory: () => {
      void controllerRef.current?.loadHistory(AbortSignal.timeout(10000)).catch(() => undefined);
    },
    environmentId: input.environmentId,
    hostEnvironmentId,
    state,
    audioLevel,
    audioRoutes,
    audioRoute,
    supported,
    unsupportedReason: !supported
      ? hostHasVoice === false
        ? "To środowisko nie obsługuje voice. Wybierz serwer oznaczony Voice w Ustawienia → Voice."
        : Platform.OS !== "android" && Platform.OS !== "ios"
          ? "Voice calls are available on iOS and Android."
          : connection?.httpAuthorization?._tag === "Dpop"
            ? "Voice calls do not support relay/DPoP connections yet."
            : !eligible
              ? "Voice calls require HTTPS and a T3 session."
              : "Voice audio is unavailable on this device."
      : null,
    start: () => {
      setCallConnection({ ...input, hostEnvironmentId, prepared: effectivePrepared });
      return controllerRef.current?.start();
    },
    stop: () => {
      audioLevel.value = 0;
      controllerRef.current?.stop();
    },
    toggleMute: async () => {
      const controller = controllerRef.current;
      await controller?.toggleMute();
      if (controller && controller === controllerRef.current && controller.state.active) {
        await getVoiceAudio()?.setCallMuted?.(controller.state.muted);
      }
    },
    setAudioRoute: async (route) => {
      const controller = controllerRef.current;
      if (!controller) throw Error("Voice connection is unavailable.");
      if (route === "bluetooth" && Platform.OS === "android" && Number(Platform.Version) >= 31) {
        const permission = await PermissionsAndroid.request("android.permission.BLUETOOTH_CONNECT");
        if (permission !== PermissionsAndroid.RESULTS.GRANTED)
          throw Error("Allow the app to connect to Bluetooth devices.");
      }
      const output =
        Platform.OS === "ios" ? (route === "speaker" ? "force_speaker" : "default") : route;
      const outputs = await AudioSession.getAudioOutputs();
      if (!outputs.includes(output))
        throw Error("Audio output is unavailable. Choose another device.");
      await AudioSession.selectAudioOutput(output);
      // The native route event confirms the actual output after routing is applied.
      if (!getVoiceAudio()?.getAudioRouteState) setAudioRoute(null);
    },
  };
}
