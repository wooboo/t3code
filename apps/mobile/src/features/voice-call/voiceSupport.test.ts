import { expect, it } from "vite-plus/test";
import { voiceSupport } from "./voiceSupport";

it("does not promise callbacks for a Nightly task routed through a full voice server", () => {
  const support = voiceSupport({
    sameEnvironment: false,
    voice: true,
    callbacks: true,
    android: true,
  });
  expect(support.label).toBe("Voice only");
  expect(support.detail).toContain("another environment");
});

it.each([undefined, false])(
  "does not infer callback support from audio support (%s)",
  (callbacks) => {
    expect(
      voiceSupport({ sameEnvironment: true, voice: true, callbacks, android: true }).label,
    ).toBe("Voice only");
  },
);

it("identifies full voice only on the supported task environment and device", () => {
  expect(
    voiceSupport({ sameEnvironment: true, voice: true, callbacks: true, android: true }).label,
  ).toBe("Full voice");
  expect(
    voiceSupport({ sameEnvironment: true, voice: true, callbacks: true, android: false }).label,
  ).toBe("Voice only");
});

it.each([undefined, false])("keeps unknown or disabled voice distinct (%s)", (voice) => {
  expect(voiceSupport({ sameEnvironment: true, voice, callbacks: true, android: true }).label).toBe(
    voice === false ? "Voice unavailable" : "Voice support unknown",
  );
});
