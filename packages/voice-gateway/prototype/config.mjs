// Throwaway A/B pilot. URLs and model IDs are explicit so runs cannot silently use paid defaults.
export function livekitPrototypeConfig(env = process.env) {
  const required = [
    "LIVEKIT_URL",
    "LIVEKIT_API_KEY",
    "LIVEKIT_API_SECRET",
    "VOICE_COMPARE_STT_URL",
    "VOICE_COMPARE_STT_MODEL",
    "VOICE_COMPARE_TTS_URL",
    "VOICE_COMPARE_TTS_MODEL",
    "VOICE_COMPARE_TTS_VOICE",
  ];
  const missing = required.filter((name) => !env[name]);
  const config = {
    url: env.LIVEKIT_URL,
    publicUrl: env.LIVEKIT_PUBLIC_URL || env.LIVEKIT_URL,
    apiKey: env.LIVEKIT_API_KEY,
    apiSecret: env.LIVEKIT_API_SECRET,
    llm: {
      model: env.T3_VOICE_LLM_MODEL || "gpt-5.6-luna",
      customEndpoint: Boolean(env.T3_VOICE_LLM_URL),
      apiType: env.T3_VOICE_LLM_API_TYPE || "responses",
    },
    stt: {
      baseURL: env.VOICE_COMPARE_STT_URL,
      model: env.VOICE_COMPARE_STT_MODEL,
      apiKey: env.VOICE_COMPARE_STT_KEY || "local",
      detectLanguage: true,
      useRealtime: false,
    },
    turn: {
      silenceMs: Number(env.VOICE_COMPARE_SILENCE_MS || 500),
      interruptions: env.VOICE_COMPARE_INTERRUPTIONS !== "false",
    },
    tts: {
      baseURL: env.VOICE_COMPARE_TTS_URL,
      model: env.VOICE_COMPARE_TTS_MODEL,
      voice: env.VOICE_COMPARE_TTS_VOICE,
      apiKey: env.VOICE_COMPARE_TTS_KEY || "local",
      sampleRate: Number(env.VOICE_COMPARE_TTS_SAMPLE_RATE || 16000),
    },
  };
  if (!missing.length) {
    if (![16000, 22050, 24000, 44100, 48000].includes(config.tts.sampleRate))
      throw Error("Unsupported PCM sample rate");
    for (const value of [config.url, config.publicUrl]) {
      if (!["ws:", "wss:"].includes(new URL(value).protocol))
        throw Error("LiveKit URL requires ws/wss");
    }
    for (const value of [config.stt.baseURL, config.tts.baseURL]) {
      if (!["http:", "https:"].includes(new URL(value).protocol))
        throw Error("Speech URL requires http/https");
    }
  }
  return { config, missing };
}

export function publicPrototypeConfig({ config, missing }, voiceSettings, baseline) {
  return {
    ready: missing.length === 0,
    missing,
    baseline: { ...baseline, cleanup: "off" },
    livekit: {
      transport: "WebRTC / LiveKit Agents 1.8.1",
      stt: config.stt.model || null,
      language: "auto (from user speech)",
      tts: config.tts.model || null,
      voice: config.tts.voice || null,
      sampleRate: config.tts.sampleRate,
      llm: voiceSettings.modelSelection || `direct:${config.llm.model}`,
      llmEndpoint: config.llm.customEndpoint ? "configured endpoint" : "OpenCode Go (external)",
      llmStreaming: voiceSettings.modelSelection
        ? "T3 provider stream (buffered when unsupported)"
        : "direct Responses stream",
      turnDetection: `Silero VAD (${config.turn.silenceMs} ms silence); no semantic Polish detector`,
      interruptions: config.turn.interruptions,
      cleanup: "off",
      history: "fresh in-memory conversation for each call",
    },
  };
}
