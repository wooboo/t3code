import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeEvents from "node:events";
import express from "express";
import { installLlmBridge } from "../src/llm-bridge.mjs";

NodeTest.test(
  "custom Chat Completions preserves streaming tool calls and keeps credentials upstream",
  async (t) => {
    const app = express();
    app.use(express.json());
    const calls = [];
    const stream =
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"search","arguments":"{}"}}]}}]}\n\ndata: [DONE]\n\n';
    installLlmBridge(app, {
      secret: "bridge-secret",
      directKey: () => "upstream-secret",
      directOrigin: "http://local-model/v1/",
      directApiType: "chat-completions",
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      },
    });
    const server = app.listen(0, "127.0.0.1");
    await NodeEvents.once(server, "listening");
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}/t3-llm/v1`;
    const body = {
      model: "direct:local-model",
      stream: true,
      messages: [{ role: "user", content: "Search" }],
      tools: [{ type: "function", function: { name: "search", parameters: { type: "object" } } }],
    };
    const request = (suffix, key = "bridge-secret") =>
      fetch(`${base}/${suffix}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    NodeAssert.equal((await request("chat/completions", "wrong")).status, 401);
    NodeAssert.equal((await request("responses")).status, 400);
    NodeAssert.equal(calls.length, 0);
    const response = await request("chat/completions");
    NodeAssert.equal(response.status, 200);
    NodeAssert.match(response.headers.get("content-type"), /text\/event-stream/);
    NodeAssert.equal(await response.text(), stream);
    NodeAssert.equal(calls[0].url, "http://local-model/v1/chat/completions");
    NodeAssert.equal(calls[0].init.headers.Authorization, "Bearer upstream-secret");
    NodeAssert.deepEqual(JSON.parse(calls[0].init.body), { ...body, model: "local-model" });
  },
);

NodeTest.test(
  "voice GLM 5.3 uses low reasoning without overriding explicit choices or other models",
  async (t) => {
    const app = express();
    app.use(express.json());
    const requests = [];
    installLlmBridge(app, {
      secret: "test",
      directKey: () => "test",
      directOrigin: "http://local-model/v1",
      directApiType: "chat-completions",
      fetchImpl: async (_url, init) => {
        requests.push(JSON.parse(init.body));
        return new Response("data: [DONE]\n\n", {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    const server = app.listen(0, "127.0.0.1");
    await NodeEvents.once(server, "listening");
    t.after(() => new Promise((resolve) => server.close(resolve)));
    for (const [model, options, expected] of [
      ["glm-5.3-flash", {}, "low"],
      ["glm-5.3", {}, "low"],
      ["glm-5.3-flash", { reasoning_effort: "high" }, "high"],
      ["custom-model", {}, undefined],
    ]) {
      const response = await fetch(
        `http://127.0.0.1:${server.address().port}/t3-llm/v1/chat/completions`,
        {
          method: "POST",
          headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
          body: JSON.stringify({
            model: `direct:${model}`,
            messages: [{ role: "user", content: "Hello" }],
            stream: true,
            ...options,
          }),
        },
      );
      NodeAssert.equal(response.status, 200);
      await response.text();
      NodeAssert.equal(requests.at(-1).reasoning_effort, expected);
      NodeAssert.equal(requests.at(-1).thinking, undefined);
    }
  },
);
