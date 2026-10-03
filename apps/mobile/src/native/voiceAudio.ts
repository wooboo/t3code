import type { VoiceAudioRoute } from "../features/voice-call/voiceCallController";

export interface VoiceAudioEventMap {
  callStopRequested: Record<string, never>;
  audioRouteChanged: { available: VoiceAudioRoute[]; selected: VoiceAudioRoute | null };
  pcm: { audio: string; level: number };
  playback: {
    type: "playback.started" | "playback.ended" | "playback.cancelled";
    responseId: string;
  };
  state: { status: "stopped" | "interrupted" | "error"; error?: string };
  route: {
    available: Array<"earpiece" | "speaker" | "bluetooth">;
    selected?: "earpiece" | "speaker" | "bluetooth";
  };
}

export interface VoiceAudio {
  waitForCallEnd?(generation: number): Promise<void>;
  startCallService?(): Promise<void>;
  stopCallService?(): Promise<void>;
  setCallMuted?(muted: boolean): Promise<void>;
  getAudioRouteState?(): Promise<VoiceAudioEventMap["audioRouteChanged"]>;
  start(options: { inputSampleRate: number; outputSampleRate: number }): Promise<void>;
  stop(): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  setAudioRoute(route: "earpiece" | "speaker" | "bluetooth"): Promise<void>;
  enqueueAudio(chunk: { pcmBase64: string; responseId: string }): Promise<void>;
  finishResponse(responseId: string): Promise<void>;
  clearPlayback(): Promise<void>;
  addListener<Event extends keyof VoiceAudioEventMap>(
    event: Event,
    listener: (payload: VoiceAudioEventMap[Event]) => void,
  ): { remove(): void };
}

export function getVoiceAudio(): VoiceAudio | null {
  return null;
}
