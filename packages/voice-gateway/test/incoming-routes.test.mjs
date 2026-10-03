import { pushDevice } from "./push-fixtures.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import express from "express";
import { IncomingCalls } from "../prototype/incoming-calls.mjs";
import { installVoicePrototype } from "../prototype/routes.mjs";

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "t3-call-routes-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [key, value] of Object.entries({
    LIVEKIT_URL: "ws://localhost",
    LIVEKIT_API_KEY: "test",
    LIVEKIT_API_SECRET: "test",
    VOICE_COMPARE_STT_URL: "http://localhost",
    VOICE_COMPARE_STT_MODEL: "test",
    VOICE_COMPARE_TTS_URL: "http://localhost",
    VOICE_COMPARE_TTS_MODEL: "test",
    VOICE_COMPARE_TTS_VOICE: "test",
  })) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  const incoming = new IncomingCalls(join(dir, "incoming.json"), { send: async () => {} });
  incoming.register("owner", pushDevice());
  const starts = [];
  const notices = [];
  const app = express();
  app.use(express.json(), (req, _res, next) => {
    req.identity = { ownerId: req.headers["x-test-owner"] || "owner" };
    next();
  });
  const close = installVoicePrototype(app, {
    incoming,
    normalizeEnvironmentId: async (id) => id || "local",
    resolveThread: async (_owner, threadId) => {
      if (!["thread", "other"].includes(threadId)) throw Error("missing thread");
      return { binding: { voiceSessionId: threadId } };
    },
    getContext: () => ({}),
    bridge: () => ({}),
    startSession: async (options) => {
      starts.push(options);
      return {
        id: "session",
        token: "test",
        url: "wss://media",
        close: async () => options.onClose(),
        notify: async (value) => notices.push(value),
      };
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await close();
    await new Promise((resolve) => server.close(resolve));
  });
  const request = (path, method = "GET", body, owner = "owner") =>
    fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method,
      headers: { "content-type": "application/json", "x-test-owner": owner },
      body: body && JSON.stringify(body),
    });
  return { request, starts, notices };
}
test("callback roundtrip binds answer to the requested thread and delivers the readiness reason", async (t) => {
  const f = await fixture(t);
  const result = await (
    await f.request("/livekit/call-user?thread=thread", "POST", {
      reason: "Wyniki",
      context: "Testy OK",
    })
  ).json();
  assert.equal(result.status, "ring_requested");
  assert.equal(
    (await f.request(`/livekit/incoming/${result.callId}`, "GET", undefined, "other-owner")).status,
    404,
  );
  assert.equal(
    (await f.request("/livekit/session?thread=other", "POST", { callbackId: result.callId }))
      .status,
    404,
  );
  assert.equal(f.starts.length, 0);
  assert.equal(
    (await f.request("/livekit/session?thread=thread", "POST", { callbackId: result.callId }))
      .status,
    200,
  );
  assert.deepEqual(f.starts[0].callbackReason, { reason: "Wyniki", context: "Testy OK" });
  const handoff = await (
    await f.request("/livekit/call-user?thread=thread", "POST", { reason: "Dodatkowy wynik" })
  ).json();
  assert.equal(handoff.status, "delivered_to_voice_agent");
  assert.equal(f.notices.length, 1);
  assert.equal((await f.request("/livekit/session/session", "DELETE")).status, 204);
  assert.equal(
    (await f.request("/livekit/session?thread=thread", "POST", { callbackId: result.callId }))
      .status,
    409,
  );
});
test("declining an invitation prevents room creation", async (t) => {
  const f = await fixture(t);
  const { callId } = await (
    await f.request("/livekit/call-user?thread=thread", "POST", { reason: "Wyniki" })
  ).json();
  assert.equal((await f.request(`/livekit/incoming/${callId}`, "DELETE")).status, 204);
  assert.equal(
    (await f.request("/livekit/session?thread=thread", "POST", { callbackId: callId })).status,
    409,
  );
  assert.equal(f.starts.length, 0);
});
