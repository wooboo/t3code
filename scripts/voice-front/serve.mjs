import { startVoiceGateway } from "../../packages/voice-gateway/src/host.mjs";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

if (!process.env.T3_VOICE_TOKEN_FILE) throw new Error("Set T3_VOICE_TOKEN_FILE");
const gateway = await startVoiceGateway({
  dataDirectory: resolve(process.env.T3_VOICE_DATA_DIR || ".t3/voice"),
  templateDirectory: new URL("../../packages/voice-gateway/config/frontend-agent/", import.meta.url)
    .pathname,
  origin: process.env.T3_VOICE_ORIGIN || "http://127.0.0.1:13773",
  getToken: async () => readFileSync(process.env.T3_VOICE_TOKEN_FILE, "utf8").trim(),
  configFile: process.env.VOICE_CONFIG_FILE,
  port: Number(process.env.T3_VOICE_PORT || 3103),
  publicBasePath: process.env.T3_VOICE_PUBLIC_BASE_PATH || "/voice/",
  publicOrigin: process.env.T3_VOICE_PUBLIC_ORIGIN,
});
console.log(`T3 voice gateway listening at ${gateway.origin}`);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => {
    await gateway.close();
  });
