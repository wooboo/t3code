import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  cancelPendingVoiceStart,
  queuePendingVoiceStart,
  takePendingVoiceStart,
} from "./pendingVoiceStart";

afterEach(() => {
  cancelPendingVoiceStart("thread");
  vi.useRealTimers();
});
function audio() {
  const stop = vi.fn();
  const close = vi.fn().mockResolvedValue(undefined);
  return {
    stop,
    close,
    prepared: {
      stream: { getTracks: () => [{ stop }] } as unknown as MediaStream,
      output: { close } as unknown as AudioContext,
    },
  };
}
it("hands microphone and playback to the promoted thread exactly once", () => {
  vi.useFakeTimers();
  const a = audio();
  queuePendingVoiceStart("thread", a.prepared);
  expect(takePendingVoiceStart("another-thread")).toBeUndefined();
  expect(takePendingVoiceStart("thread")).toBe(a.prepared);
  expect(takePendingVoiceStart("thread")).toBeUndefined();
  vi.runAllTimers();
  expect(a.stop).not.toHaveBeenCalled();
  expect(a.close).not.toHaveBeenCalled();
});
it("releases microphone and playback if promotion fails or is never consumed", () => {
  vi.useFakeTimers();
  const first = audio();
  queuePendingVoiceStart("thread", first.prepared);
  cancelPendingVoiceStart("thread");
  expect(first.stop).toHaveBeenCalledOnce();
  expect(first.close).toHaveBeenCalledOnce();
  const abandoned = audio();
  queuePendingVoiceStart("thread", abandoned.prepared);
  vi.runAllTimers();
  expect(abandoned.stop).toHaveBeenCalledOnce();
  expect(abandoned.close).toHaveBeenCalledOnce();
  expect(takePendingVoiceStart("thread")).toBeUndefined();
});
