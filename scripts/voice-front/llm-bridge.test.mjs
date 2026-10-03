import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeEvents from "node:events";
import { installLlmBridge, responseEnvelope } from "./llm-bridge.mjs";

NodeTest.test("direct requests preserve conversation routing across response formats", async () => {
  const seen = [];
  const { routes, res } = fixture({
    fetchImpl: async (_url, options) => {
      seen.push({ headers: options.headers, body: JSON.parse(options.body) });
      return Response.json({ output: [] });
    },
  });
  for (const [sessionId, suffix] of [
    ["thread-a", "responses"],
    ["thread-a", "chat/completions"],
    ["thread-b", "responses"],
  ]) {
    const model =
      "direct-session:" +
      Buffer.from(JSON.stringify({ model: "gpt-5.6-luna", sessionId })).toString("base64url");
    await routes.get(`/t3-llm/v1/${suffix}`)(
      {
        headers: { authorization: "Bearer local-secret" },
        body: { model, input: "Hello", messages: [{ role: "user", content: "Hello" }] },
      },
      res,
    );
  }
  NodeAssert.deepEqual(
    seen.map((x) => x.headers["x-opencode-session"]),
    ["thread-a", "thread-a", "thread-b"],
  );
  NodeAssert.ok(
    seen.every(
      (x) => x.body.model === "gpt-5.6-luna" && x.headers["User-Agent"] === "t3-code-voice/1.0",
    ),
  );
});

function fixture(options = {}) {
  const routes = new Map();
  installLlmBridge(
    { post: (route, handler) => routes.set(route, handler) },
    {
      executor: {
        request: async () => {
          throw Error("Unexpected inference");
        },
      },
      secret: "local-secret",
      directKey: () => "provider-secret",
      ...options,
    },
  );
  const res = new NodeEvents.EventEmitter();
  res.statusCode = 200;
  res.chunks = [];
  res.headers = {};
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.type = (type) => {
    res.headers["Content-Type"] = type;
    return res;
  };
  res.setHeader = (key, value) => {
    res.headers[key] = value;
  };
  res.json = (body) => {
    res.body = body;
    res.ended = true;
    return res;
  };
  res.write = (chunk) => {
    res.chunks.push(chunk.toString());
    return true;
  };
  res.end = () => {
    res.ended = true;
    return res;
  };
  return { routes, res };
}

NodeTest.test("private bridge rejects missing or incorrect bearer before inference", async () => {
  for (const authorization of [undefined, "Bearer wrong", "Bearer local-secret-extra"]) {
    const { routes, res } = fixture();
    await routes.get("/t3-llm/v1/responses")({ headers: { authorization }, body: {} }, res);
    NodeAssert.equal(res.statusCode, 401);
    NodeAssert.equal(res.ended, true);
  }
});

NodeTest.test(
  "text-only direct chat uses Responses and keeps provider credential server-side",
  async () => {
    let requested;
    const { routes, res } = fixture({
      fetchImpl: async (url, options) => {
        requested = { url, options };
        return Response.json({
          id: "resp_test",
          created_at: 1,
          status: "completed",
          output: [{ content: [{ type: "output_text", text: "Clean text" }] }],
        });
      },
    });
    await routes.get("/t3-llm/v1/chat/completions")(
      {
        headers: { authorization: "Bearer local-secret" },
        body: {
          model: "direct:gpt-5.6-luna",
          messages: [{ role: "user", content: "Um clean text" }],
          max_tokens: 80,
        },
      },
      res,
    );
    NodeAssert.equal(requested.url, "https://opencode.ai/zen/go/v1/responses");
    NodeAssert.equal(requested.options.headers.Authorization, "Bearer provider-secret");
    NodeAssert.equal(JSON.parse(requested.options.body).max_output_tokens, 80);
    NodeAssert.equal(res.body.choices[0].message.content, "Clean text");
    NodeAssert.equal(JSON.stringify(res.body).includes("provider-secret"), false);
  },
);

NodeTest.test(
  "native SSE retains tool requests and labels its non-streaming generation honestly",
  async () => {
    const selection = { instanceId: "codex", model: "chosen" };
    let request;
    const { routes, res } = fixture({
      executor: {
        request: async (...args) => {
          request = args;
          return {
            text: "Sprawdzę",
            toolCalls: [{ name: "spawn_thinking", arguments: '{"task":"inspect"}' }],
          };
        },
      },
    });
    await routes.get("/t3-llm/v1/responses")(
      {
        headers: { authorization: "Bearer local-secret" },
        body: {
          model: "t3:" + Buffer.from(JSON.stringify(selection)).toString("base64url"),
          stream: true,
          input: [{ role: "user", content: "Sprawdź" }],
          tools: [{ type: "function", name: "spawn_thinking" }],
        },
      },
      res,
    );
    NodeAssert.equal(request[0], "/api/voice/respond");
    NodeAssert.deepEqual(request[1].modelSelection, selection);
    NodeAssert.equal(res.headers["X-T3-Native-Streaming"], "false");
    NodeAssert.match(res.chunks.join(""), /response\.completed/);
    NodeAssert.match(res.chunks.join(""), /spawn_thinking/);
  },
);

NodeTest.test(
  "disconnect aborts native inference without serializing private upstream errors",
  async () => {
    const { routes, res } = fixture({
      executor: {
        request: async (_path, _body, signal) => {
          res.emit("close");
          NodeAssert.equal(signal.aborted, true);
          throw Error("private prompt and provider credential");
        },
      },
    });
    await routes.get("/t3-llm/v1/responses")(
      {
        headers: { authorization: "Bearer local-secret" },
        body: {
          model:
            "t3:" +
            Buffer.from(JSON.stringify({ instanceId: "codex", model: "chosen" })).toString(
              "base64url",
            ),
          input: [],
        },
      },
      res,
    );
    NodeAssert.equal(res.body, undefined);
    NodeAssert.equal(res.ended, true);
  },
);

NodeTest.test(
  "native tool response cannot override tool_choice none or use non-object arguments",
  () => {
    const tools = [{ name: "spawn_thinking" }];
    const result = (args) => ({
      text: "",
      toolCalls: [{ name: "spawn_thinking", arguments: args }],
    });
    NodeAssert.throws(() => responseEnvelope(result("{}"), "test", tools, "none"), /disabled/);
    for (const args of ["null", "[]", "true", "12", '"text"'])
      NodeAssert.throws(() => responseEnvelope(result(args), "test", tools), /JSON object/);
    NodeAssert.equal(responseEnvelope(result("{}"), "test", tools).output[0].type, "function_call");
  },
);

NodeTest.test(
  "direct text-only chat rejects tools rather than silently losing their semantics",
  async () => {
    const { routes, res } = fixture({
      fetchImpl: async () => {
        throw Error("Must not contact provider");
      },
    });
    await routes.get("/t3-llm/v1/chat/completions")(
      {
        headers: { authorization: "Bearer local-secret" },
        body: {
          model: "direct:gpt-5.6-luna",
          messages: [],
          tools: [{ type: "function", function: { name: "spawn_thinking" } }],
        },
      },
      res,
    );
    NodeAssert.equal(res.statusCode, 400);
    NodeAssert.equal(res.body.error.type, "unsupported_request");
  },
);

NodeTest.test("backpressure removes the unused close listener after every drain", async () => {
  const { routes, res } = fixture({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/event-stream" }),
      body: (async function* () {
        for (let index = 0; index < 24; index++) yield Buffer.from("chunk");
      })(),
    }),
  });
  res.write = () => {
    queueMicrotask(() => res.emit("drain"));
    return false;
  };
  await routes.get("/t3-llm/v1/responses")(
    {
      headers: { authorization: "Bearer local-secret" },
      body: { model: "direct:gpt-5.6-luna", stream: true, input: [] },
    },
    res,
  );
  NodeAssert.equal(res.listenerCount("close"), 1); // The request-level AbortController only.
  NodeAssert.equal(res.listenerCount("drain"), 0);
  NodeAssert.equal(res.ended, true);
});

NodeTest.test(
  "configured local Responses endpoint receives requests without external fallback",
  async () => {
    const calls = [];
    const { routes, res } = fixture({
      directOrigin: "http://127.0.0.1:18092/v1",
      directKey: () => "local",
      fetchImpl: async (url, options) => {
        calls.push({ url, key: options.headers.Authorization, body: JSON.parse(options.body) });
        return new Response("local model unavailable", { status: 503 });
      },
    });
    await routes.get("/t3-llm/v1/responses")(
      {
        headers: { authorization: "Bearer local-secret" },
        body: { model: "direct:local-model", input: "Hello", stream: true },
      },
      res,
    );
    NodeAssert.equal(res.statusCode, 503);
    NodeAssert.deepEqual(calls, [
      {
        url: "http://127.0.0.1:18092/v1/responses",
        key: "Bearer local",
        body: { model: "local-model", input: "Hello", stream: true },
      },
    ]);
  },
);
