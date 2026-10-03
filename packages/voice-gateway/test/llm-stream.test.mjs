import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeEvents from "node:events";
import express from "express";
import { ChatContext, initializeLogger } from "@livekit/agents";
import * as openai from "@livekit/agents-plugin-openai";
import { installLlmBridge } from "../src/llm-bridge.mjs";
import { T3VoiceExecutor } from "../src/t3-executor.mjs";

initializeLogger({ level: "silent", pretty: false });
const modelId =
  "t3:" + Buffer.from(JSON.stringify({ instanceId: "codex", model: "test" })).toString("base64url");
async function bridge(t, streamVoiceResponse) {
  const app = express();
  app.use(express.json());
  installLlmBridge(app, { secret: "test", executor: { streamVoiceResponse } });
  const server = app.listen(0, "127.0.0.1");
  await NodeEvents.once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${server.address().port}/t3-llm/v1`;
}
const post = (origin, body, signal) =>
  fetch(origin + "/responses", {
    method: "POST",
    headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
    body: JSON.stringify({ model: modelId, input: [], stream: true, ...body }),
    signal,
  });

NodeTest.test("LiveKit receives spoken text while the provider is still generating", async (t) => {
  const finish = Promise.withResolvers();
  let completed = false;
  const origin = await bridge(t, async function* () {
    yield { type: "text.delta", delta: "Już sprawdzam. " };
    await finish.promise;
    completed = true;
    yield { type: "text.delta", delta: "Gotowe." };
    yield { type: "completed", result: { text: "Już sprawdzam. Gotowe.", toolCalls: [] } };
  });
  const model = new openai.responses.LLM({
    baseURL: origin,
    apiKey: "test",
    model: modelId,
    useWebSocket: false,
    store: false,
  });
  const errors = [];
  model.on("error", (e) => errors.push(e));
  const chatCtx = ChatContext.empty();
  chatCtx.addMessage({ role: "user", content: "Hello" });
  let text = "";
  const stream = model.chat({ chatCtx, connOptions: { maxRetry: 0, timeoutMs: 5000 } });
  try {
    for await (const chunk of stream)
      if (chunk.delta?.content) {
        if (!text) {
          NodeAssert.equal(completed, false);
          NodeAssert.equal(chunk.delta.content, "Już sprawdzam. ");
          finish.resolve();
        }
        text += chunk.delta.content;
      }
    NodeAssert.equal(text, "Już sprawdzam. Gotowe.");
    NodeAssert.deepEqual(errors, []);
  } finally {
    finish.resolve();
    await stream.close();
    await model.close();
  }
});

NodeTest.test(
  "tools arrive only with validated completion; partial failures never complete",
  async (t) => {
    for (const fail of [false, true]) {
      const finish = Promise.withResolvers();
      const origin = await bridge(t, async function* () {
        yield { type: "text.delta", delta: "Sprawdzam." };
        await finish.promise;
        if (fail) throw Error("provider failure");
        yield {
          type: "completed",
          result: { text: "Sprawdzam.", toolCalls: [{ name: "delegate", arguments: "{}" }] },
        };
      });
      const response = await post(origin, { tools: [{ type: "function", name: "delegate" }] });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let body = "";
      while (!body.includes("response.output_text.delta"))
        body += decoder.decode((await reader.read()).value, { stream: true });
      NodeAssert.ok(!body.includes("function_call"));
      NodeAssert.ok(!body.includes("response.completed"));
      finish.resolve();
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        body += decoder.decode(next.value, { stream: true });
      }
      NodeAssert.equal(body.includes("response.completed"), !fail);
      NodeAssert.equal(body.includes("function_call"), !fail);
      NodeAssert.equal(body.includes("response.failed"), fail);
    }
  },
);

NodeTest.test("client cancellation reaches provider without redispatch", async (t) => {
  const cancelled = Promise.withResolvers();
  let calls = 0;
  const origin = await bridge(t, async function* (_input, signal) {
    calls++;
    try {
      yield { type: "text.delta", delta: "Hello." };
      await new Promise((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", resolve, { once: true });
      });
    } finally {
      cancelled.resolve();
    }
  });
  const abort = new AbortController();
  const response = await post(origin, {}, abort.signal);
  const reader = response.body.getReader();
  let data = "";
  while (!data.includes("response.output_text.delta"))
    data += new TextDecoder().decode((await reader.read()).value);
  abort.abort();
  await cancelled.promise;
  NodeAssert.equal(calls, 1);
});

NodeTest.test("executor decodes split UTF-8 SSE and rejects premature EOF", async () => {
  for (const complete of [true, false]) {
    const delta = { type: "text.delta", delta: "Cześć 😀" };
    const end = { type: "completed", result: { text: delta.delta, toolCalls: [] } };
    const wire = new TextEncoder().encode(
      `data: ${JSON.stringify(delta)}\r\n\r\n` +
        (complete ? `data: ${JSON.stringify(end)}\n\n` : ""),
    );
    const executor = new T3VoiceExecutor({
      origin: "http://test",
      token: "secret",
      fetchImpl: async (_url, init) => {
        NodeAssert.equal(init.headers.Authorization, "Bearer secret");
        return new Response(
          new ReadableStream({
            start(controller) {
              for (const byte of wire) controller.enqueue(Uint8Array.of(byte));
              controller.close();
            },
          }),
        );
      },
    });
    const events = [];
    const run = async () => {
      for await (const event of executor.streamVoiceResponse({ prompt: "test" }))
        events.push(event);
    };
    if (complete) {
      await run();
      NodeAssert.deepEqual(events, [delta, end]);
    } else {
      await NodeAssert.rejects(run, /before completion/);
      NodeAssert.deepEqual(events, [delta]);
    }
  }
});
