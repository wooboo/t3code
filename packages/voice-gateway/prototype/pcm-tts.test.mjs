import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeHttp from "node:http";
import * as NodeEvents from "node:events";
import { initializeLogger } from "@livekit/agents";
import { PcmTTS } from "./pcm-tts.mjs";
initializeLogger({ level: "error", pretty: false });

NodeTest.test(
  "PCM synthesis preserves the endpoint's 16 kHz audio across uneven HTTP chunks",
  async () => {
    const pcm = Buffer.alloc(9600);
    for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(1234, i);
    let request;
    const server = NodeHttp.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      request = JSON.parse(Buffer.concat(chunks));
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.write(pcm.subarray(0, 13));
      res.end(pcm.subarray(13));
    });
    server.listen(0, "127.0.0.1");
    await NodeEvents.once(server, "listening");
    const tts = new PcmTTS({
      baseURL: `http://127.0.0.1:${server.address().port}/v1`,
      model: "local-test",
      voice: "neutral",
      sampleRate: 16000,
      apiKey: "local",
    });
    try {
      const frames = [];
      for await (const chunk of tts.synthesize("Test")) frames.push(chunk);
      NodeAssert.deepEqual(request, {
        input: "Test",
        model: "local-test",
        voice: "neutral",
        response_format: "pcm",
      });
      NodeAssert.ok(frames.length > 0);
      NodeAssert.ok(frames.every((x) => x.frame.sampleRate === 16000 && x.frame.channels === 1));
      NodeAssert.equal(frames.at(-1).final, true);
      NodeAssert.equal(frames.filter((x) => x.final).length, 1);
      NodeAssert.deepEqual(
        Buffer.concat(
          frames.map((x) =>
            Buffer.from(x.frame.data.buffer, x.frame.data.byteOffset, x.frame.data.byteLength),
          ),
        ),
        pcm,
      );
    } finally {
      await tts.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  },
);

NodeTest.test(
  "the voice TTS produces audio before the LLM closes its text stream",
  { timeout: 3000 },
  async (t) => {
    const requests = [];
    t.mock.method(globalThis, "fetch", async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return new Response(new Uint8Array(6400));
    });
    const speech = new PcmTTS({
      baseURL: "http://speech.test/v1",
      model: "test",
      voice: "test",
      sampleRate: 16000,
      apiKey: "test",
    });
    const audio = speech.stream();
    let text;
    audio.updateInputStream(
      new ReadableStream({
        start(controller) {
          text = controller;
        },
      }),
    );
    try {
      text.enqueue("Już sprawdzam.");
      const first = await audio.next();
      NodeAssert.equal(first.done, false);
      NodeAssert.equal(first.value.frame.sampleRate, 16000);
      NodeAssert.equal(requests[0].input, "Już sprawdzam.");
      // The model can continue preparing tool arguments after speech has begun.
      text.close();
      for await (const _frame of audio) {
        /* drain synthesis */
      }
    } finally {
      await audio.close();
      await speech.close();
    }
  },
);

NodeTest.test(
  "interrupting synthesis does not report a fatal TTS error",
  { timeout: 3000 },
  async (t) => {
    const started = Promise.withResolvers();
    t.mock.method(globalThis, "fetch", (_url, { signal }) => {
      started.resolve();
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const speech = new PcmTTS({ baseURL: "http://speech.test/v1", sampleRate: 16000 });
    const errors = [];
    speech.on("error", (error) => errors.push(error));
    const abort = new AbortController();
    const audio = speech.synthesize("Przerwij mnie.", undefined, abort.signal);
    const drained = (async () => {
      for await (const _frame of audio) {
      }
    })();
    await started.promise;
    abort.abort();
    await drained;
    await new Promise(setImmediate);
    NodeAssert.deepEqual(errors, []);
    await speech.close();
  },
);

NodeTest.test(
  "cancelling a PCM response body leaves subsequent speech usable",
  { timeout: 3000 },
  async (t) => {
    const started = Promise.withResolvers();
    let request = 0;
    t.mock.method(globalThis, "fetch", async (_url, { signal }) => {
      if (request++ > 0) return new Response(new Uint8Array(6400));
      return new Response(
        new ReadableStream({
          start(controller) {
            signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
            started.resolve();
          },
        }),
      );
    });
    const speech = new PcmTTS({ baseURL: "http://speech.test/v1", sampleRate: 16000 });
    const errors = [];
    speech.on("error", (error) => errors.push(error));
    const audio = speech.synthesize("Pierwsza wypowiedź.");
    const drained = (async () => {
      for await (const _frame of audio) {
      }
    })();
    await started.promise;
    audio.close();
    await drained;
    const frames = [];
    for await (const frame of speech.synthesize("Kolejna wypowiedź.")) frames.push(frame);
    NodeAssert.ok(frames.length > 0);
    NodeAssert.deepEqual(errors, []);
    await speech.close();
  },
);
