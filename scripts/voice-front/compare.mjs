// Temporary Minion/LAN launcher. All processes and writable state belong to this pilot.
import * as NodeChildProcess from "node:child_process";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeUtil from "node:util";

if (Number(process.versions.node.split(".")[0]) < 24)
  throw Error("Run with Node 24 (pnpm dlx node@24.13.1 scripts/voice-front/compare.mjs).");
const initialEnv = { ...process.env };
const root = NodePath.resolve(new URL("../../", import.meta.url).pathname);
const home = NodePath.resolve(
  process.env.VOICE_COMPARE_HOME || NodePath.join(root, ".t3/voice-compare"),
);
if (
  home === NodePath.join(NodeOS.homedir(), ".t3") ||
  home === NodePath.join(NodeOS.homedir(), ".t3/userdata")
)
  throw Error("Choose an isolated prototype home");
NodeFS.mkdirSync(home, { recursive: true, mode: 0o700 });
const configFile = NodePath.join(home, "config.env");
if (NodeFS.existsSync(configFile))
  Object.assign(process.env, {
    ...NodeUtil.parseEnv(NodeFS.readFileSync(configFile, "utf8")),
    ...process.env,
  });
const port = Number(process.env.VOICE_COMPARE_PORT || 18180);
const publicOrigin = process.env.VOICE_COMPARE_PUBLIC_ORIGIN || `http://localhost:${port}`;
const lanIp =
  process.env.VOICE_COMPARE_LAN_IP ||
  Object.values(NodeOS.networkInterfaces())
    .flat()
    .find((i) => i.family === "IPv4" && !i.internal && i.address.startsWith("10.11.12."))
    ?.address ||
  "127.0.0.1";
const speechRepo =
  process.env.VOICE_COMPARE_SPEECH_REPO || NodePath.join(NodeOS.homedir(), "Work/speech-to-speech");
const python = NodePath.join(speechRepo, ".venv/bin/python");
if (!NodeFS.existsSync(python)) throw Error(`Missing speech environment: ${python}`);
const localTts = process.env.VOICE_COMPARE_TTS === "breeze";
const defaultTts = localTts
  ? {
      url: "http://127.0.0.1:18091/v1",
      model: "mlx-community/Breeze-TTS-2-mlx-4bit",
      voice: "neutral",
      sampleRate: "24000",
    }
  : {
      url: "http://127.0.0.1:18092/v1",
      model: "eleven_flash_v2_5",
      voice: "JBFqnCBsd6RMkjVDRZzb",
      sampleRate: "16000",
    };
const env = {
  ...process.env,
  VOICE_COMPARE_CONFIG_FILE: configFile,
  VOICE_COMPARE_LAUNCHER_PID: String(process.pid),
  PATH: `${NodePath.dirname(process.execPath)}:${NodePath.join(root, "node_modules/.bin")}:${process.env.PATH}`,
  T3_VOICE_ENABLED: "1",
  VOICE_COMPARE_ENABLED: "1",
  VITE_VOICE_COMPARE_ENABLED: "1",
  T3CODE_PORT_OFFSET: process.env.T3CODE_PORT_OFFSET || "14000",
  T3CODE_DEV_ALLOWED_ORIGINS: publicOrigin,
  T3_VOICE_PUBLIC_ORIGIN: publicOrigin,
  LIVEKIT_URL: "ws://127.0.0.1:18880",
  LIVEKIT_PUBLIC_URL: publicOrigin.replace(/^http/, "ws"),
  LIVEKIT_API_KEY: process.env.LIVEKIT_API_KEY || "t3-voice-prototype",
  LIVEKIT_API_SECRET: process.env.LIVEKIT_API_SECRET || NodeCrypto.randomBytes(32).toString("hex"),
  VOICE_COMPARE_STT_URL: process.env.VOICE_COMPARE_STT_URL || "http://127.0.0.1:18090/v1",
  VOICE_COMPARE_STT_MODEL:
    process.env.VOICE_COMPARE_STT_MODEL || "mlx-community/parakeet-tdt-0.6b-v3",
  VOICE_COMPARE_TTS_URL: process.env.VOICE_COMPARE_TTS_URL || defaultTts.url,
  VOICE_COMPARE_TTS_MODEL: process.env.VOICE_COMPARE_TTS_MODEL || defaultTts.model,
  VOICE_COMPARE_TTS_VOICE: process.env.VOICE_COMPARE_TTS_VOICE || defaultTts.voice,
  VOICE_COMPARE_TTS_SAMPLE_RATE: process.env.VOICE_COMPARE_TTS_SAMPLE_RATE || defaultTts.sampleRate,
  VOICE_COMPARE_BASELINE_MODELS: JSON.stringify({
    stt: process.env.VOICE_COMPARE_STT_MODEL || "mlx-community/parakeet-tdt-0.6b-v3",
    tts: process.env.VOICE_COMPARE_TTS_MODEL || defaultTts.model,
    voice: process.env.VOICE_COMPARE_TTS_VOICE || defaultTts.voice,
    llm: process.env.T3_VOICE_LLM_MODEL || "gpt-5.6-luna",
    turnDetection: "Smart Turn + VAD",
  }),
  T3_VOICE_PORT: "18103",
};
delete env.VOICE_CONFIG_FILE;
delete env.VITE_HTTP_URL;
delete env.VITE_WS_URL;
const children = [];
let closing = false;
let webPort;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  proxy.close();
  for (const child of children) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
  }
  await NodeTimersPromises.setTimeout(4000);
  for (const child of children) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }
};
function launch(label, executable, args, extraEnv = {}) {
  const log =
    label === "t3" ? "pipe" : NodeFS.openSync(NodePath.join(home, `${label}.log`), "a", 0o600);
  const child = NodeChildProcess.spawn(executable, args, {
    cwd: root,
    detached: true,
    env: { ...env, ...extraEnv },
    stdio: ["ignore", log, log],
  });
  children.push(child);
  child.on("error", (error) => {
    console.error(`${label}: ${error.message}`);
    void shutdown();
  });
  child.on("exit", (code) => {
    if (!closing) {
      console.error(`${label} exited (${code}); inspect ${home}`);
      void shutdown();
    }
  });
  return child;
}
const upstreamPort = (url) => (/^\/rtc(?:\/|\?|$)/.test(url) ? 18880 : webPort);
const proxy = NodeHttp.createServer((req, res) => {
  const target = upstreamPort(req.url);
  if (!target) {
    res.writeHead(503);
    res.end("Starting prototype");
    return;
  }
  const upstream = NodeHttp.request(
    {
      hostname: "localhost",
      port: target,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: `localhost:${target}` },
    },
    (response) => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end("Prototype upstream unavailable");
  });
  req.on("aborted", () => upstream.destroy());
  req.pipe(upstream);
});
proxy.on("upgrade", (req, socket, head) => {
  const target = upstreamPort(req.url);
  if (!target) {
    socket.destroy();
    return;
  }
  const upstream = NodeNet.connect({ host: "localhost", port: target }, () => {
    const headers = { ...req.headers, host: `localhost:${target}` };
    upstream.write(
      `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${Object.entries(headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\r\n")}\r\n\r\n`,
    );
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
  socket.on("close", () => upstream.destroy());
});
process.on("SIGUSR2", () => {
  if (closing) return;
  void (async () => {
    await shutdown();
    const restartEnv = { ...initialEnv };
    for (const key of [
      "VOICE_COMPARE_TTS_URL",
      "VOICE_COMPARE_STT_URL",
      "T3_VOICE_LLM_URL",
      "T3_VOICE_LLM_KEY",
    ])
      delete restartEnv[key];
    // Saved operator settings must win over inherited values after applying.
    for (const key of Object.keys(NodeUtil.parseEnv(NodeFS.readFileSync(configFile, "utf8"))))
      delete restartEnv[key];
    const child = NodeChildProcess.spawn(process.execPath, [import.meta.filename], {
      cwd: root,
      env: restartEnv,
      detached: true,
      stdio: "inherit",
    });
    child.unref();
    process.exit(0);
  })();
});
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
try {
  await new Promise((ok, fail) => {
    proxy.once("error", fail);
    proxy.listen(port, "0.0.0.0", ok);
  });
  const mediaConfig = NodePath.join(home, "livekit.yaml");
  NodeFS.writeFileSync(
    mediaConfig,
    `port: 18880\nbind_addresses: ["0.0.0.0"]\nrtc:\n  tcp_port: 18881\n  udp_port: 18882\n  node_ip: ${lanIp}\n  use_external_ip: false\nkeys:\n  ${env.LIVEKIT_API_KEY}: ${env.LIVEKIT_API_SECRET}\n`,
    { mode: 0o600 },
  );
  launch("livekit", process.env.LIVEKIT_SERVER_BIN || "livekit-server", ["--config", mediaConfig]);
  if (!process.env.VOICE_COMPARE_STT_URL)
    launch("stt", python, [
      NodePath.join(root, "packages/voice-gateway/prototype/stt-server.py"),
      "--model",
      env.VOICE_COMPARE_STT_MODEL,
    ]);
  if (!localTts && !process.env.VOICE_COMPARE_TTS_URL)
    launch("tts", python, [
      NodePath.join(root, "packages/voice-gateway/prototype/elevenlabs-tts-server.py"),
    ]);
  const dev = launch("t3", process.execPath, [
    "scripts/dev-runner.ts",
    "dev",
    "--home-dir",
    home,
    "--dev-url",
    publicOrigin,
  ]);
  let lines = "";
  dev.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    lines += chunk;
    const match = lines.match(/serverPort=(\d+) webPort=(\d+)/);
    if (match) webPort = Number(match[2]);
    if (lines.length > 20000) lines = lines.slice(-10000);
  });
  dev.stderr.on("data", (chunk) => process.stderr.write(chunk));
  const bridgeFile = NodePath.join(home, "voice/bridge-token");
  let servicesReady = false;
  for (let attempt = 0; attempt < 120 && !closing; attempt++) {
    if (NodeFS.existsSync(bridgeFile) && webPort) {
      try {
        await fetch("http://127.0.0.1:18103/", { signal: AbortSignal.timeout(1000) });
        if (!process.env.VOICE_COMPARE_STT_URL) {
          const ready = await fetch("http://127.0.0.1:18090/health", {
            signal: AbortSignal.timeout(1000),
          });
          if (!ready.ok) throw Error("STT starting");
        }
        servicesReady = true;
        break;
      } catch {
        /* Wait for the services before the speech pipeline warmup. */
      }
    }
    await NodeTimersPromises.setTimeout(500);
  }
  if (closing || !servicesReady) throw Error("T3 did not start");
  NodeFS.writeFileSync(
    NodePath.join(home, "processes.json"),
    JSON.stringify(
      {
        launcher: process.pid,
        spawned: children.map((child) => child.pid),
        home,
        publicOrigin,
        webPort,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(
    `[voice-compare] ${publicOrigin} — pair using the T3 link above; configure Settings → Voice; start LiveKit from the chat microphone.`,
  );
} catch (error) {
  console.error(error.message);
  await shutdown();
  process.exitCode = 1;
}
