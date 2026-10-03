// Explicit synthetic-audio smoke test against an isolated pilot.
import fs from "node:fs";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
const require = createRequire(
  new URL("../../packages/voice-gateway/package.json", import.meta.url),
);
const WebSocket = require("ws");
const base = process.env.T3_VOICE_PUBLIC_ORIGIN;
const thread = process.env.T3_VOICE_TEST_THREAD;
if (!base || !thread || !process.env.T3_VOICE_TOKEN_FILE)
  throw Error("Set explicit test origin, thread and token file");
const token = fs.readFileSync(process.env.T3_VOICE_TOKEN_FILE, "utf8").trim();
const headers = {
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
  Origin: base,
};
let socket;
try {
  const binding = await fetch(
    `${base}/voice/t3-connect?thread=${encodeURIComponent(thread)}&format=json`,
    { headers },
  );
  const { sessionId } = await binding.json();
  if (!sessionId) throw Error("Binding failed");
  const tts = await fetch("http://127.0.0.1:8091/v1/audio/speech", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "eleven_flash_v2_5",
      voice: "JBFqnCBsd6RMkjVDRZzb",
      input: "Eee, hmm, odpowiedz krótko: dwa plus dwa.",
      response_format: "pcm",
    }),
  });
  if (!tts.ok) throw Error("Synthetic audio generation failed");
  const pcm = Buffer.from(await tts.arrayBuffer());
  let bytes = 0,
    transcript = false,
    sent = false;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error("Full voice smoke timed out")), 60000);
    socket = new WebSocket(
      `${base.replace("https:", "wss:")}/voice/api/realtime?sessionId=${sessionId}`,
      { headers },
    );
    const send = (event) =>
      socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify(event));
    socket.on("open", () =>
      send({
        type: "connect",
        clientType: "web",
        inputEnabled: true,
        outputEnabled: true,
        voiceEnabled: true,
        locale: "pl-PL",
      }),
    );
    socket.on("error", reject);
    socket.on("message", (raw) => {
      void (async () => {
        const e = JSON.parse(raw);
        if (e.type === "error") throw Error(e.message);
        if (e.type === "voice.ready" && !sent) {
          sent = true;
          const audio = Buffer.concat([Buffer.alloc(16000), pcm, Buffer.alloc(48000)]);
          for (let offset = 0; offset < audio.length; offset += 1280) {
            send({
              type: "audio.append",
              audio: audio.subarray(offset, offset + 1280).toString("base64"),
            });
            await delay(40);
          }
        }
        if (e.type === "transcript.final" && e.role === "assistant") {
          transcript = true;
          console.log("ASSISTANT", e.content);
        }
        if (e.type === "audio.delta") {
          bytes += Buffer.from(e.audio, "base64").length;
          send({ type: "playback.started", responseId: e.responseId });
        }
        if (e.type === "audio.done") send({ type: "playback.ended", responseId: e.responseId });
        if (transcript && bytes > 0) {
          clearTimeout(timeout);
          console.log("PASS speech→LLM→TTS", { audioBytes: bytes });
          resolve();
        }
      })().catch((error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  });
} finally {
  socket?.close();
}
