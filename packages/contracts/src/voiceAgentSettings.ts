/** Configuration of the environment's voice comparison services. Credentials stay on the host. */
export type VoiceAgentSettings = {
  ttsProvider: "elevenlabs" | "breeze" | "custom";
  ttsUrl: string;
  ttsModel: string;
  ttsVoice: string;
  ttsSampleRate: 16000 | 22050 | 24000 | 44100 | 48000;
  sttUrl: string;
  sttModel: string;
  llmUrl: string;
  llmApiType: "responses" | "chat-completions";
  llmModel: string;
  silenceMs: number;
  interruptions: boolean;
};
export type VoiceAgentSettingsSnapshot = {
  writable?: boolean;
  config: VoiceAgentSettings;
  active: VoiceAgentSettings;
  restartRequired: boolean;
  llmKeyConfigured: boolean;
};

export type VoiceExecutionTarget = {
  environmentId: string;
  label: string;
  origin: string;
  expiresAt: number;
};
