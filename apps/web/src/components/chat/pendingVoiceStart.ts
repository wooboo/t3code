/** Carries user-gesture microphone permission and audio playback across draft promotion. */
export type PreparedVoiceAudio = { stream: MediaStream; output: AudioContext };
const pending = new Map<
  string,
  { audio: PreparedVoiceAudio; timer: ReturnType<typeof setTimeout> }
>();
export function cancelPendingVoiceStart(threadId: string) {
  const entry = pending.get(threadId);
  if (!entry) return;
  pending.delete(threadId);
  clearTimeout(entry.timer);
  entry.audio.stream.getTracks().forEach((track) => track.stop());
  void entry.audio.output.close();
}
export function queuePendingVoiceStart(threadId: string, audio: PreparedVoiceAudio) {
  cancelPendingVoiceStart(threadId);
  pending.set(threadId, {
    audio,
    timer: setTimeout(() => cancelPendingVoiceStart(threadId), 30000),
  });
}
export function takePendingVoiceStart(threadId: string) {
  const entry = pending.get(threadId);
  if (!entry) return undefined;
  pending.delete(threadId);
  clearTimeout(entry.timer);
  return entry.audio;
}
