import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { z } from "zod";

const url = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      return ["http:", "https:"].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  }, "Enter an HTTP or HTTPS URL");
const name = z.string().trim().min(1).max(256);
export const agentSettingsSchema = z
  .object({
    ttsProvider: z.enum(["elevenlabs", "breeze", "custom"]),
    ttsUrl: url,
    ttsModel: name,
    ttsVoice: name,
    ttsSampleRate: z.union([
      z.literal(16000),
      z.literal(22050),
      z.literal(24000),
      z.literal(44100),
      z.literal(48000),
    ]),
    sttUrl: url,
    sttModel: name,
    llmKey: z.string().max(8192).optional(),
    llmApiType: z.enum(["responses", "chat-completions"]),
    llmUrl: z.union([z.literal(""), url]),
    llmModel: name,
    silenceMs: z.number().int().min(200).max(2000),
    interruptions: z.boolean(),
  })
  .strict();
const keys = {
  ttsProvider: "VOICE_COMPARE_TTS",
  ttsUrl: "VOICE_COMPARE_TTS_URL",
  ttsModel: "VOICE_COMPARE_TTS_MODEL",
  ttsVoice: "VOICE_COMPARE_TTS_VOICE",
  ttsSampleRate: "VOICE_COMPARE_TTS_SAMPLE_RATE",
  sttUrl: "VOICE_COMPARE_STT_URL",
  sttModel: "VOICE_COMPARE_STT_MODEL",
  llmUrl: "T3_VOICE_LLM_URL",
  llmApiType: "T3_VOICE_LLM_API_TYPE",
  llmModel: "T3_VOICE_LLM_MODEL",
  silenceMs: "VOICE_COMPARE_SILENCE_MS",
  interruptions: "VOICE_COMPARE_INTERRUPTIONS",
};
export function readAgentSettings(env) {
  const breeze = env.VOICE_COMPARE_TTS === "breeze";
  return {
    ttsProvider: env.VOICE_COMPARE_TTS || "elevenlabs",
    ttsUrl:
      env.VOICE_COMPARE_TTS_URL ||
      (breeze ? "http://127.0.0.1:18091/v1" : "http://127.0.0.1:18092/v1"),
    ttsModel:
      env.VOICE_COMPARE_TTS_MODEL ||
      (breeze ? "mlx-community/Breeze-TTS-2-mlx-4bit" : "eleven_flash_v2_5"),
    ttsVoice: env.VOICE_COMPARE_TTS_VOICE || (breeze ? "neutral" : "JBFqnCBsd6RMkjVDRZzb"),
    ttsSampleRate: Number(env.VOICE_COMPARE_TTS_SAMPLE_RATE || (breeze ? 24000 : 16000)),
    sttUrl: env.VOICE_COMPARE_STT_URL || "http://127.0.0.1:18090/v1",
    sttModel: env.VOICE_COMPARE_STT_MODEL || "mlx-community/parakeet-tdt-0.6b-v3",
    llmUrl: env.T3_VOICE_LLM_URL || "",
    llmApiType: env.T3_VOICE_LLM_API_TYPE || "responses",
    llmModel: env.T3_VOICE_LLM_MODEL || "gpt-5.6-luna",
    silenceMs: Number(env.VOICE_COMPARE_SILENCE_MS || 500),
    interruptions: env.VOICE_COMPARE_INTERRUPTIONS !== "false",
  };
}
export function saveAgentSettings(file, input) {
  const config = agentSettingsSchema.parse(input);
  if (config.llmApiType === "chat-completions" && !config.llmUrl)
    throw Error("Set an API URL for Chat Completions");
  if (
    config.ttsProvider === "elevenlabs" &&
    (config.ttsUrl !== "http://127.0.0.1:18092/v1" || config.ttsSampleRate !== 16000)
  )
    throw Error("ElevenLabs requires the local bridge on port 18092 and 16000 Hz PCM");
  if (
    config.ttsProvider === "breeze" &&
    (config.ttsUrl !== "http://127.0.0.1:18091/v1" ||
      config.ttsSampleRate !== 24000 ||
      config.ttsVoice !== "neutral" ||
      config.ttsModel !== "mlx-community/Breeze-TTS-2-mlx-4bit")
  )
    throw Error("Breeze requires the local model, neutral voice, and 24000 Hz PCM");
  const saved = NodeFS.existsSync(file) ? NodeUtil.parseEnv(NodeFS.readFileSync(file, "utf8")) : {};
  for (const [field, key] of Object.entries(keys)) saved[key] = String(config[field]);
  if (config.llmKey !== undefined) {
    if (config.llmKey.trim()) saved.T3_VOICE_LLM_KEY = config.llmKey.trim();
    else delete saved.T3_VOICE_LLM_KEY;
  }
  // Keep built-in services managed by the launcher; explicit URLs select custom services.
  if (config.ttsProvider !== "custom") delete saved.VOICE_COMPARE_TTS_URL;
  if (config.sttUrl === "http://127.0.0.1:18090/v1") delete saved.VOICE_COMPARE_STT_URL;
  if (!config.llmUrl) delete saved.T3_VOICE_LLM_URL;
  const contents =
    Object.entries(saved)
      .map(([key, value]) => {
        if (/[\r\n"\\]/.test(value)) throw Error("Configuration contains unsupported characters");
        return `${key}="${value}"`;
      })
      .join("\n") + "\n";
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(file + ".tmp", contents, { mode: 0o600 });
  NodeFS.renameSync(file + ".tmp", file);
  return readAgentSettings(saved);
}
export function mountAgentSettings(app, env = process.env) {
  const file = env.VOICE_COMPARE_CONFIG_FILE || env.VOICE_CONFIG_FILE;
  const active = readAgentSettings(env);
  const snapshot = () => {
    const saved =
      file && NodeFS.existsSync(file) ? NodeUtil.parseEnv(NodeFS.readFileSync(file, "utf8")) : env;
    const config = readAgentSettings(saved);
    return {
      config,
      writable: Boolean(file),
      active,
      llmKeyConfigured: Boolean(saved.T3_VOICE_LLM_KEY),
      restartRequired:
        JSON.stringify(config) !== JSON.stringify(active) ||
        (saved.T3_VOICE_LLM_KEY || "") !== (env.T3_VOICE_LLM_KEY || ""),
    };
  };
  app.get("/agent-settings", (_req, res) => res.json(snapshot()));
  app.patch("/agent-settings", (req, res) => {
    if (!file)
      return res.status(503).json({
        error:
          "Service configuration is read-only. Conversation and callback settings can still be saved.",
      });
    try {
      saveAgentSettings(file, req.body);
      res.json(snapshot());
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });
  app.post("/agent-settings/apply", (_req, res) => {
    const pid = Number(env.VOICE_COMPARE_LAUNCHER_PID);
    if (!Number.isInteger(pid) || pid < 2)
      return res.status(503).json({ error: "Voice service launcher is unavailable" });
    res.on("finish", () => process.kill(pid, "SIGUSR2"));
    res.json({ restarting: true });
  });
}
