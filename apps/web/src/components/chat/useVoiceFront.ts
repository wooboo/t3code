import { mergeVoiceHistory } from "@t3tools/client-runtime/voice-input";
import { useEffect, useRef, useState } from "react";
import { useStableCallback } from "../../hooks/useStableCallback";
import { takePendingVoiceStart, type PreparedVoiceAudio } from "./pendingVoiceStart";
import { voiceError } from "./voiceAudio";

type Transcript = {
  id: string;
  role: string;
  content: string;
};
type VoiceState = {
  status: string;
  active: boolean;
  muted: boolean;
  error: string;
  transcript: Transcript[];
  // Wall-clock call bounds, kept after the call ends for the session summary.
  // Nullable-not-optional keys keep exactOptionalPropertyTypes happy.
  startedAt: number | undefined;
  endedAt: number | undefined;
  // Turn latencies sampled during the call; bounded so long calls stay cheap.
  latency: {
    lastUserAt: number | undefined;
    responses: number[];
    transcription: number[];
  };
  // Raw agent SDK metrics streamed by the gateway, newest last; bounded.
  sdkMetrics: Array<Record<string, unknown>>;
};
const initial: VoiceState = {
  status: "",
  active: false,
  muted: false,
  error: "",
  transcript: [],
  startedAt: undefined,
  endedAt: undefined,
  latency: { lastUserAt: undefined, responses: [], transcription: [] },
  sdkMetrics: [],
};
type PipelineStat = { label: string; ms: number | null; samples: number; unit: "ms" | "tok/s" };

/** Mean of latency samples in milliseconds, or null before any sample arrives. */
export function averageLatency(samples: number[]) {
  return samples.length ? samples.reduce((sum, ms) => sum + ms, 0) / samples.length : null;
}

/** One-decimal seconds label for turn-latency averages. */
export function formatLatency(ms: number | null) {
  return ms === null ? "" : `${(ms / 1000).toFixed(1)}s`;
}

/** mm:ss below an hour, h:mm:ss beyond that; readable without units while talking. */
export function formatCallDuration(ms: number) {
  const total = Math.max(0, Math.round(ms / 1000));
  const seconds = String(total % 60).padStart(2, "0");
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  return `${hours ? hours + ":" : ""}${String(minutes).padStart(hours ? 2 : 1, "0")}:${seconds}`;
}

/** Two-line clock label for a call bound in the session summary. */
export function formatCallClock(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export type { PipelineStat };

// Every stage the gateway's agent SDK measures, in pipeline order.
const METRIC_FIELDS: Array<{
  type: string;
  field: string;
  label: string;
  unit: "ms" | "tok/s";
  positiveOnly?: boolean;
  skipCancelled?: boolean;
}> = [
  {
    type: "eou_metrics",
    field: "endOfUtteranceDelayMs",
    label: "End of speech delay",
    unit: "ms",
  },
  { type: "eou_metrics", field: "transcriptionDelayMs", label: "Transcription", unit: "ms" },
  {
    type: "stt_metrics",
    field: "durationMs",
    label: "STT request",
    unit: "ms",
    positiveOnly: true,
  },
  {
    type: "llm_metrics",
    field: "ttftMs",
    label: "LLM first token",
    unit: "ms",
    skipCancelled: true,
  },
  {
    type: "llm_metrics",
    field: "durationMs",
    label: "LLM total",
    unit: "ms",
    skipCancelled: true,
  },
  {
    type: "llm_metrics",
    field: "tokensPerSecond",
    label: "LLM throughput",
    unit: "tok/s",
    skipCancelled: true,
  },
  {
    type: "tts_metrics",
    field: "ttfbMs",
    label: "TTS first byte",
    unit: "ms",
    skipCancelled: true,
  },
  {
    type: "tts_metrics",
    field: "durationMs",
    label: "TTS synthesis",
    unit: "ms",
    skipCancelled: true,
  },
];

/** Pipeline questionnaire: the mean over every stage the gateway measured this call. */
export function summarizePipelineStats(
  sdkMetrics: ReadonlyArray<Record<string, unknown>>,
  responses: ReadonlyArray<number>,
): PipelineStat[] {
  const stats: PipelineStat[] = [
    {
      label: "End-to-end response",
      ms: averageLatency([...responses]),
      samples: responses.length,
      unit: "ms",
    },
  ];
  for (const { type, field, label, unit, positiveOnly, skipCancelled } of METRIC_FIELDS) {
    const samples: number[] = [];
    for (const metric of sdkMetrics) {
      if (metric.type !== type) continue;
      if (skipCancelled && metric.cancelled) continue;
      const value = Number(metric[field]);
      if (!Number.isFinite(value)) continue;
      if (positiveOnly && value <= 0) continue;
      samples.push(value);
    }
    if (samples.length === 0) continue;
    stats.push({
      label,
      ms: averageLatency(samples),
      samples: samples.length,
      unit,
    });
  }
  return stats;
}

export function useVoiceFront(threadId: string | null, environmentId?: string) {
  const [state, setState] = useState<VoiceState>(initial);
  const [deviceId, setDeviceId] = useState("");
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const resources = useRef<{
    stop: () => void;
    mute: (value: boolean) => void;
    send: (event: Record<string, unknown>) => void;
  } | null>(null);
  const generation = useRef(0);
  const origin = import.meta.env.VITE_VOICE_FRONT_ORIGIN || "/voice/";
  const enabled = Boolean(import.meta.env.DEV && origin && threadId);
  const historyRequest = useRef<AbortController | null>(null);
  const refreshHistory = useStableCallback(() => {
    const atRequestStart = state.transcript;
    historyRequest.current?.abort();
    const historyAbort = new AbortController();
    historyRequest.current = historyAbort;
    if (origin && threadId) {
      const url = new URL("t3-history", new URL(origin, window.location.origin));
      url.searchParams.set("thread", threadId);
      if (environmentId) url.searchParams.set("environmentId", environmentId);
      void fetch(url, { signal: historyAbort.signal })
        .then(async (response) => {
          if (!response.ok) return;
          const data = await response.json();
          if (!historyAbort.signal.aborted && Array.isArray(data.messages))
            setState((s) => ({
              ...s,
              transcript: mergeVoiceHistory<Transcript>(
                data.messages,
                s.transcript,
                atRequestStart,
              ),
            }));
        })
        .catch(() => {});
    }
  });

  function stop() {
    generation.current++;
    resources.current?.stop();
    resources.current = null;
    setState((s) => ({
      ...s,
      active: false,
      muted: false,
      status: "Call ended",
      endedAt: (s.startedAt && !s.endedAt ? Date.now() : s.endedAt) ?? undefined,
    }));
  }

  useEffect(() => {
    setState(initial);
    setSettingsOpen(false);
    refreshHistory();
    window.addEventListener("focus", refreshHistory);
    const settingsChanged = (event: Event) => {
      if ((event as CustomEvent<{ threadId: string }>).detail?.threadId === threadId)
        resources.current?.send({ type: "t3.settings.refresh" });
    };
    window.addEventListener("t3-voice-settings-changed", settingsChanged);
    return () => {
      historyRequest.current?.abort();
      window.removeEventListener("focus", refreshHistory);
      window.removeEventListener("t3-voice-settings-changed", settingsChanged);
      generation.current++;
      resources.current?.stop();
      resources.current = null;
    };
  }, [threadId, origin, environmentId, refreshHistory]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled || !enabled || !threadId) return;
      const prepared = takePendingVoiceStart(
        environmentId ? `${environmentId}:${threadId}` : threadId,
      );
      if (prepared) void start(prepared);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, threadId, environmentId]);

  async function start(prepared?: PreparedVoiceAudio) {
    if (!enabled || resources.current) return;
    const run = ++generation.current;
    let stream: MediaStream | undefined = prepared?.stream;
    let room: import("livekit-client").Room | undefined;
    let connectionId: string | undefined;
    const output = prepared?.output ?? new AudioContext();
    void output.resume();
    const abort = new AbortController();
    const playbacks = new Map<
      import("livekit-client").RemoteTrack,
      { element: HTMLAudioElement; source: MediaStreamAudioSourceNode }
    >();
    const sessionUrl = new URL("livekit/session", new URL(origin, window.location.origin));
    const releaseSession = (id: string) =>
      void fetch(`${sessionUrl.href}/${encodeURIComponent(id)}`, {
        method: "DELETE",
        keepalive: true,
      }).catch(() => {});
    const detach = (track: import("livekit-client").RemoteTrack) => {
      const playback = playbacks.get(track);
      if (!playback) return;
      playback.source.disconnect();
      track.detach(playback.element);
      playback.element.pause();
      playback.element.srcObject = null;
      playback.element.remove();
      playbacks.delete(track);
    };
    const cleanup = () => {
      abort.abort();
      clearTimeout(timeout);
      for (const track of playbacks.keys()) detach(track);
      stream?.getTracks().forEach((track) => track.stop());
      void room?.disconnect();
      void output.close();
      if (connectionId) releaseSession(connectionId);
    };
    const fail = (message: string) => {
      if (generation.current !== run) return;
      // Keep the underlying transport error in the browser console for diagnosis.
      console.error("voice call failure:", message);
      stop();
      setState((s) => ({ ...s, error: voiceError(message) }));
    };
    const timeout = setTimeout(() => fail("Connection timeout"), 45000);
    resources.current = {
      send: () => {},
      stop: cleanup,
      mute: (value) =>
        stream?.getAudioTracks().forEach((track) => {
          track.enabled = !value;
        }),
    };
    setState((s) => ({ ...s, active: true, muted: false, error: "", status: "Connecting…" }));
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw Error("NotAllowed");
      stream =
        stream ??
        (await navigator.mediaDevices.getUserMedia({
          audio: {
            ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        }));
      if (generation.current !== run) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      setDevices(
        (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput"),
      );
      const { DisconnectReason, Room, RoomEvent, Track } = await import("livekit-client");
      if (generation.current !== run) return;
      sessionUrl.searchParams.set("thread", threadId!);
      if (environmentId) sessionUrl.searchParams.set("environmentId", environmentId);
      const response = await fetch(sessionUrl, { method: "POST", signal: abort.signal });
      if (!response.ok) throw Error(String(response.status));
      const connection = (await response.json()) as { id: string; url: string; token: string };
      connectionId = connection.id;
      // Cleanup uses the collection URL without the thread query.
      sessionUrl.search = "";
      if (generation.current !== run) {
        releaseSession(connectionId);
        return;
      }
      room = new Room();
      room.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind !== Track.Kind.Audio || generation.current !== run) return;
        // A playing media element pulls Chromium's remote RTC stream; WebAudio owns output.
        const element = document.createElement("audio");
        element.hidden = true;
        element.volume = 0;
        document.body.append(element);
        track.attach(element);
        element.muted = true;
        const source = output.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]));
        source.connect(output.destination);
        playbacks.set(track, { element, source });
        void element.play().catch((error: unknown) => fail(String(error)));
      });
      room.on(RoomEvent.TrackUnsubscribed, detach);
      room.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
        if (
          generation.current !== run ||
          participant?.identity !== `voice-agent-${connection.id}` ||
          topic !== "t3.voice.prototype"
        )
          return;
        try {
          const event = JSON.parse(new TextDecoder().decode(payload));
          if (event.type === "call.ended") {
            stop();
          } else if (event.type === "voice.state") {
            const labels: Record<string, string> = {
              listening: "Listening",
              thinking: "Thinking…",
              speaking: "Speaking",
              initializing: "Connecting…",
            };
            if (labels[event.state]) setState((s) => ({ ...s, status: labels[event.state]! }));
          } else if (event.type === "transcript.final" && typeof event.content === "string") {
            const entry = {
              id: String(event.id),
              role: String(event.role),
              content: event.content,
            };
            const now = Date.now();
            setState((s) => {
              const isUser = entry.role === "user";
              const latency = {
                // Response time = user transcript completion → assistant reply arrival.
                responses:
                  !isUser && s.latency.lastUserAt
                    ? [...s.latency.responses, now - s.latency.lastUserAt].slice(-25)
                    : s.latency.responses,
                transcription: s.latency.transcription,
                lastUserAt: isUser ? now : s.latency.lastUserAt,
              };
              return {
                ...s,
                latency,
                transcript: [...s.transcript.filter((t) => t.id !== entry.id), entry].slice(-100),
              };
            });
          } else if (event.type === "sdk.metrics") {
            const metric = event.metrics as Record<string, unknown> | undefined;
            if (metric && metric.type !== "vad_metrics") {
              setState((s) => {
                // STT transcription delay stays the flat latency sample it always was.
                const eou =
                  metric.type === "eou_metrics" ? Number(metric.transcriptionDelayMs) : NaN;
                return {
                  ...s,
                  sdkMetrics: [...s.sdkMetrics, metric].slice(-100),
                  ...(Number.isFinite(eou) && eou > 0
                    ? {
                        latency: {
                          ...s.latency,
                          transcription: [...s.latency.transcription, eou].slice(-25),
                        },
                      }
                    : {}),
                };
              });
            }
          } else if (event.type === "error") fail(String(event.message));
        } catch {
          fail("Invalid LiveKit event");
        }
      });
      room.on(RoomEvent.Reconnecting, () => {
        if (generation.current === run) setState((s) => ({ ...s, status: "Reconnecting…" }));
      });
      room.on(RoomEvent.Reconnected, () => {
        if (generation.current === run) setState((s) => ({ ...s, status: "Listening" }));
      });
      room.on(RoomEvent.Disconnected, (reason) => {
        if (generation.current !== run) return;
        if (reason === DisconnectReason.ROOM_DELETED) stop();
        else fail("LiveKit disconnected");
      });
      await room.connect(connection.url, connection.token);
      if (generation.current !== run) {
        await room.disconnect();
        return;
      }
      await room.localParticipant.publishTrack(stream.getAudioTracks()[0]!, {
        source: Track.Source.Microphone,
      });
      if (generation.current !== run) return;
      clearTimeout(timeout);
      setState((s) => ({ ...s, status: "Listening", startedAt: s.startedAt ?? Date.now() }));
    } catch (error) {
      fail(String(error));
    }
  }

  return {
    ...state,
    refreshHistory,
    enabled,
    start,
    stop,
    deviceId,
    setDeviceId,
    devices,
    settingsOpen,
    toggleSettings: () => setSettingsOpen((open) => !open),
    toggleMute: () => {
      resources.current?.mute(!state.muted);
      setState((s) => ({ ...s, muted: !s.muted }));
    },
  };
}
