import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
const { test } = NodeTest;
const assert = NodeAssert;
import { benchmarkProviders } from "./provider-benchmark.mjs";

test("bounds model selection and never fabricates token streaming measurements", async () => {
  await assert.rejects(benchmarkProviders({ models: [] }), /Choose/);
  const result = await benchmarkProviders({
    origin: "http://localhost",
    token: "private",
    models: [{ instanceId: "codex", model: "test" }],
    fetchImpl: async (url, options) => {
      assert.equal(url.pathname, "/api/voice/respond");
      assert.equal(options.headers.Authorization, "Bearer private");
      assert.equal(JSON.parse(options.body).modelSelection.model, "test");
      return Response.json({ text: "Gotowe", toolCalls: [], elapsedMs: 123, streaming: false });
    },
  });
  assert.equal(result[0].serverElapsedMs, 123);
  assert.equal(result[0].ttftMs, null);
  assert.equal(JSON.stringify(result).includes("private"), false);
});

test("provider failure is reported independently and remaining chosen models still run", async () => {
  let calls = 0;
  const result = await benchmarkProviders({
    origin: "http://localhost",
    token: "private",
    models: [{ instanceId: "codex", model: "test" }],
    samples: 2,
    fetchImpl: async () =>
      ++calls === 1
        ? new Response(null, { status: 503 })
        : Response.json({ text: "OK", toolCalls: [], elapsedMs: 10 }),
  });
  assert.deepEqual(
    result.map((row) => row.ok),
    [false, true],
  );
  assert.equal(result[0].error, "HTTP 503");
});
