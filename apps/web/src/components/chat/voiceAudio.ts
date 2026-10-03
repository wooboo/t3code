export function encodePcm(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, i) => {
    const value = Math.max(-1, Math.min(1, sample));
    view.setInt16(i * 2, value * (value < 0 ? 32768 : 32767), true);
  });
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
}

export function decodePcm(encoded: string): Float32Array<ArrayBuffer> {
  const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  return Float32Array.from(
    { length: Math.floor(bytes.length / 2) },
    (_, i) => view.getInt16(i * 2, true) / 32768,
  );
}

export function voiceError(message: string): string {
  const raw = message?.trim() || "";
  if (/session_limit|capacity_busy/.test(raw))
    return "The speech server is busy. End the call on your other device and try again.";
  if (/NotAllowed|Permission/.test(raw)) return "Allow microphone access in this site’s settings.";
  if (/NotFound/.test(raw)) return "No microphone found. Connect one and try again.";
  if (/\b401\b|\b403\b/.test(raw)) return "Your session expired. Pair this device with T3 again.";
  const fallback =
    "Could not connect the call. Check your microphone and connection, then try again.";
  // Dev pilot: keep the raw reason visible before the generic message so drops are diagnosable.
  return raw ? `${fallback} (${raw.slice(0, 400)})` : fallback;
}

// The context uses the provider rate; aggregate render quanta into 40 ms PCM packets.
export const captureWorklet = `class VoiceCapture extends AudioWorkletProcessor {
  constructor() { super(); this.samples = []; }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) for (const sample of channel) this.samples.push(sample);
    if (this.samples.length >= sampleRate * 0.04) {
      this.port.postMessage(new Float32Array(this.samples)); this.samples = [];
    }
    return true;
  }
}
registerProcessor('t3-voice-capture', VoiceCapture);`;
