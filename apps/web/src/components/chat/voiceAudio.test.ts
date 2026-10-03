import { describe, expect, it } from "vite-plus/test";
import { decodePcm, encodePcm, voiceError } from "./voiceAudio";

describe("voice PCM transport", () => {
  it("encodes signed little-endian PCM16 with clipping", () => {
    const data = encodePcm(new Float32Array([-2, -1, 0, 1, 2]));
    expect(Array.from(atob(data), (c) => c.charCodeAt(0))).toEqual([
      0, 128, 0, 128, 0, 0, 255, 127, 255, 127,
    ]);
  });
  it("preserves microphone samples within PCM quantization error", () => {
    const samples = new Float32Array([-0.9, -0.5, 0, 0.25, 0.8]);
    const result = decodePcm(encodePcm(samples));
    samples.forEach((value, i) => expect(Math.abs(value - result[i]!)).toBeLessThan(1 / 16384));
  });
  it("explains the occupied speech slot and microphone permissions in English", () => {
    expect(voiceError("session_limit_reached")).toContain("other device");
    expect(voiceError("NotAllowedError")).toContain("Allow microphone access");
    expect(voiceError("401")).toContain("Pair this device");
  });
});
