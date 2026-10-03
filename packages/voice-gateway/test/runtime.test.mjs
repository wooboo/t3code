import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { startVoiceGateway } from "../src/host.mjs";

function messages(socket) {
  const received = [];
  const waiting = [];
  socket.on("message", (data) => {
    const event = JSON.parse(String(data));
    received.push(event);
    for (const waiter of [...waiting]) {
      if (!waiter.matches(event)) continue;
      waiting.splice(waiting.indexOf(waiter), 1);
      waiter.resolve(event);
    }
  });
  return (type, predicate = () => true) => {
    const matches = (event) => event.type === type && predicate(event);
    const existing = received.find(matches);
    return existing
      ? Promise.resolve(existing)
      : new Promise((resolve) => waiting.push({ matches, resolve }));
  };
}

test(
  "in-repo gateway retains Android binding, unmodified transcription and duplex PCM across restarts",
  { timeout: 15000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "t3-voice-gateway-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    let token = "first-token";
    const t3 = createServer((req, res) => {
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401).end();
        return;
      }
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/orchestration/shell")
        res.end(
          JSON.stringify({
            projects: [{ id: "project", workspaceRoot: directory }],
            threads: [{ id: "thread", projectId: "project", title: "Voice test" }],
          }),
        );
      else if (req.url === "/api/orchestration/threads/thread")
        res.end(JSON.stringify({ projection: { thread: {}, messages: [], runs: [] } }));
      else if (req.url === "/api/voice/catalogue")
        res.end(JSON.stringify({ providers: [], capabilities: [] }));
      else res.writeHead(404).end();
    });
    t3.listen(0, "127.0.0.1");
    await once(t3, "listening");
    t.after(() => new Promise((resolve) => t3.close(resolve)));
    const speech = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await once(speech, "listening");
    t.after(() => {
      for (const client of speech.clients) client.terminate();
      speech.close();
    });
    const speechConnected = new Promise((resolve) =>
      speech.once("connection", (socket) => {
        const next = messages(socket);
        socket.send(JSON.stringify({ type: "session.created", session: {} }));
        resolve({ socket, next });
      }),
    );
    const configFile = join(directory, "speech.env");
    await writeFile(
      configFile,
      `QWEN_AUDIO_REALTIME_PROVIDER=speech-to-speech\nSPEECH_TO_SPEECH_REALTIME_URL=ws://127.0.0.1:${speech.address().port}/v1/realtime\nQWEN_AUDIO_LOG_LEVEL=error\n`,
    );
    const options = {
      ...(process.env.T3_TEST_VOICE_WORKER
        ? { workerUrl: new URL(process.env.T3_TEST_VOICE_WORKER) }
        : {}),
      dataDirectory: join(directory, "voice"),
      templateDirectory: fileURLToPath(new URL("../config/frontend-agent/", import.meta.url)),
      origin: `http://127.0.0.1:${t3.address().port}`,
      configFile,
      getToken: async () => token,
    };
    const originalPort = process.env.PORT;
    const originalConfig = process.env.QWAUDIO_CONFIG_DIR;
    let gateway = await startVoiceGateway(options);
    t.after(() => gateway.close());
    assert.equal(process.env.PORT, originalPort);
    assert.equal(process.env.QWAUDIO_CONFIG_DIR, originalConfig);
    const binding = await fetch(gateway.origin + "/t3-connect?thread=thread&format=json");
    assert.equal(binding.status, 200);
    const { sessionId } = await binding.json();
    assert.ok(sessionId);
    // A renewed host credential takes effect without restarting the gateway.
    token = "renewed-token";
    const settings = await fetch(gateway.origin + "/t3-settings?thread=thread", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instructions: { thread: "Test thread instructions" } }),
    });
    assert.equal(settings.status, 200);
    const client = new WebSocket(
      gateway.origin.replace("http:", "ws:") + `/api/realtime?sessionId=${sessionId}`,
    );
    t.after(() => client.terminate());
    const nextClient = messages(client);
    await once(client, "open");
    client.send(
      JSON.stringify({
        type: "connect",
        clientType: "mobile",
        clientLabel: "T3 Code",
        voiceEnabled: true,
        inputEnabled: true,
        outputEnabled: true,
        locale: "pl-PL",
      }),
    );
    const ready = await nextClient("voice.ready");
    assert.equal(ready.inputSampleRate, 16000);
    const upstream = await speechConnected;
    const sessionUpdate = await upstream.next("session.update");
    assert.match(sessionUpdate.session.model, /^direct-session:/);
    assert.equal((await upstream.next("t3.cleanup.configure")).mode, "off");
    // A short VAD pause may finalize an item which the provider then reopens.
    // Its transcript is cumulative, so both finals must address the same bubble.
    const transcribe = async (itemId, content) => {
      for (const event of [
        { type: "input_audio_buffer.speech_started", item_id: itemId },
        { type: "input_audio_buffer.speech_stopped", item_id: itemId },
        {
          type: "conversation.item.input_audio_transcription.completed",
          item_id: itemId,
          transcript: content,
        },
      ])
        upstream.socket.send(JSON.stringify(event));
      return nextClient(
        "transcript.final",
        (event) => event.role === "user" && event.content === content,
      );
    };
    const first = await transcribe("utterance-a", "Sprawdź ten plik");
    const resumed = await transcribe("utterance-a", "Sprawdź ten plik i dodaj test");
    assert.equal(resumed.turnId, first.turnId);
    const distinct = await transcribe("utterance-b", "Sprawdź ten plik ponownie");
    assert.notEqual(distinct.turnId, first.turnId);
    const transcriptHistory = await (
      await fetch(gateway.origin + "/t3-history?thread=thread")
    ).json();
    const utterance = transcriptHistory.messages.filter(
      (message) => message.id === `user:${first.turnId}`,
    );
    assert.equal(utterance.length, 1);
    assert.equal(utterance[0].content, "Sprawdź ten plik i dodaj test");
    const audio = Buffer.alloc(640).toString("base64");
    client.send(JSON.stringify({ type: "audio.append", audio }));
    assert.equal((await upstream.next("input_audio_buffer.append")).audio, audio);
    upstream.socket.send(
      JSON.stringify({ type: "response.output_audio.delta", response_id: "reply", delta: audio }),
    );
    assert.equal((await nextClient("audio.delta")).audio, audio);
    upstream.socket.send(
      JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "speech-turn",
        transcript: "hej",
      }),
    );
    assert.equal(
      (await nextClient("transcript.final", (event) => event.content === "hej")).content,
      "hej",
    );
    client.close();
    await once(client, "close");
    await gateway.close();
    assert.equal(gateway.closed, true);
    await assert.rejects(fetch(gateway.origin + "/livez"));
    gateway = await startVoiceGateway(options);
    const rebound = await fetch(gateway.origin + "/t3-connect?thread=thread&format=json");
    assert.equal((await rebound.json()).sessionId, sessionId);
    const history = await fetch(gateway.origin + "/t3-history?thread=thread");
    assert.ok((await history.json()).messages.some((message) => message.content === "hej"));
    assert.equal(
      (
        await fetch(gateway.origin + "/t3-llm/v1/responses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
      401,
    );
  },
);

test("startup failure terminates the worker and leaves the host environment alone", async () => {
  await assert.rejects(
    startVoiceGateway({
      configFile: "/nonexistent/t3-voice-config.env",
      getToken: async () => "unused",
      dataDirectory: "/nonexistent",
      templateDirectory: "/nonexistent",
      origin: "http://127.0.0.1:1",
    }),
    /ENOENT/,
  );
});
