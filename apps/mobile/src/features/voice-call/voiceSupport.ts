export function voiceSupport(input: {
  sameEnvironment: boolean;
  voice?: boolean;
  callbacks?: boolean;
  android: boolean;
}) {
  if (input.voice !== true)
    return {
      label: input.voice === false ? "Voice unavailable" : "Voice support unknown",
      detail: "Connect to a voice-enabled server to check support.",
    };
  if (!input.sameEnvironment)
    return {
      label: "Voice only",
      detail: "Tasks run on another environment. Use a thread on the voice server for callbacks.",
    };
  if (!input.android || input.callbacks !== true)
    return {
      label: "Voice only",
      detail: "Callbacks are not confirmed for this environment and device.",
    };
  return {
    label: "Full voice",
    detail: "Calls and agent callbacks supported. Enable callbacks in Voice settings.",
  };
}
