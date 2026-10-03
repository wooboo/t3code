import { dirname, join } from "node:path";
import { config } from "../core/config.mjs";
import { VoiceContextStore } from "./voice-context-store.mjs";
export const voiceContexts = new VoiceContextStore(
  join(dirname(config.backendSessionStatePath), "voice-contexts.json"),
);
