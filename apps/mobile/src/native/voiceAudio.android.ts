import { requireNativeModule } from "expo";

import type { VoiceAudio } from "./voiceAudio";

let voiceAudio: VoiceAudio | null | undefined;

export function getVoiceAudio(): VoiceAudio | null {
  if (voiceAudio !== undefined) return voiceAudio;
  try {
    voiceAudio = requireNativeModule<VoiceAudio>("T3VoiceAudio");
  } catch {
    voiceAudio = null;
  }
  return voiceAudio;
}

export type { VoiceAudio, VoiceAudioEventMap } from "./voiceAudio";
