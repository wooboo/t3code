import { pushDevice } from "./push-fixtures.mjs";
import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeEvents from "node:events";
import express from "express";
import { IncomingCalls } from "../prototype/incoming-calls.mjs";
import { installVoicePrototype } from "../prototype/routes.mjs";

async function fixture(
  t,
  { autoCallback = false, execute = async () => ({ content: "Done" }) } = {},
) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-call-routes-"));
  t.after(() => NodeFS.rmSync(dir, { recursive: true, force: true }));
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
  const incoming = new IncomingCalls(NodePath.join(dir, "incoming.json"), { send: async () => {} });
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
    getAutoCallback: () => autoCallback,
    executor: { runSelectedSession: execute },
    normalizeEnvironmentId: async (id) => id || "local",
    resolveThread: async (_owner, threadId) => {
      if (!["thread", "other"].includes(threadId)) throw Error("missing thread");
      return { binding: { voiceSessionId: threadId } };
    },
    getContext: () => ({}),
    bridge: () => ({}),
    startSession: async (options) => {
      starts.push(options);
      options.onConnectionChange(true);
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
  await NodeEvents.once(server, "listening");
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
  return { request, starts, notices, incoming };
}
NodeTest.test(
  "callback roundtrip binds answer to the requested thread and delivers the readiness reason",
  async (t) => {
    const f = await fixture(t);
    const result = await (
      await f.request("/livekit/call-user?thread=thread", "POST", {
        reason: "Wyniki",
        context: "Testy OK",
      })
    ).json();
    NodeAssert.equal(result.status, "ring_requested");
    NodeAssert.equal(
      (await f.request(`/livekit/incoming/${result.callId}`, "GET", undefined, "other-owner"))
        .status,
      404,
    );
    NodeAssert.equal(
      (await f.request("/livekit/session?thread=other", "POST", { callbackId: result.callId }))
        .status,
      404,
    );
    NodeAssert.equal(f.starts.length, 0);
    NodeAssert.equal(
      (await f.request("/livekit/session?thread=thread", "POST", { callbackId: result.callId }))
        .status,
      200,
    );
    NodeAssert.deepEqual(f.starts[0].callbackReason, { reason: "Wyniki", context: "Testy OK" });
    const handoff = await (
      await f.request("/livekit/call-user?thread=thread", "POST", { reason: "Dodatkowy wynik" })
    ).json();
    NodeAssert.equal(handoff.status, "delivered_to_voice_agent");
    NodeAssert.equal(f.notices.length, 1);
    NodeAssert.equal((await f.request("/livekit/session/session", "DELETE")).status, 204);
    NodeAssert.equal(
      (await f.request("/livekit/session?thread=thread", "POST", { callbackId: result.callId }))
        .status,
      409,
    );
  },
);
NodeTest.test("declining an invitation prevents room creation", async (t) => {
  const f = await fixture(t);
  const { callId } = await (
    await f.request("/livekit/call-user?thread=thread", "POST", { reason: "Wyniki" })
  ).json();
  NodeAssert.equal((await f.request(`/livekit/incoming/${callId}`, "DELETE")).status, 204);
  NodeAssert.equal(
    (await f.request("/livekit/session?thread=thread", "POST", { callbackId: callId })).status,
    409,
  );
  NodeAssert.equal(f.starts.length, 0);
});

NodeTest.test(
  "a delegated task completing after hangup requests a callback that can be answered",
  async (t) => {
    let finish;
    const completed = new Promise((resolve) => {
      finish = resolve;
    });
    const f = await fixture(t, { autoCallback: true, execute: () => completed });
    NodeAssert.equal((await f.request("/livekit/session?thread=thread", "POST")).status, 200);
    const work = f.starts[0].executor.runSelectedSession({}, { objective: "Implement change" });
    NodeAssert.equal((await f.request("/livekit/session/session", "DELETE")).status, 204);
    finish({ content: "Change implemented and tested" });
    await work;
    const [invitation] = Object.values(f.incoming.state.calls);
    NodeAssert.equal(invitation.status, "pending");
    NodeAssert.equal(invitation.threadId, "thread");
    NodeAssert.equal(
      (await f.request("/livekit/session?thread=thread", "POST", { callbackId: invitation.id }))
        .status,
      200,
    );
    NodeAssert.equal(f.starts[1].callbackReason.context, "Change implemented and tested");
  },
);
