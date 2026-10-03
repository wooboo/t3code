import { pushDevice } from "./push-fixtures.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IncomingCalls } from "../prototype/incoming-calls.mjs";
const target = { ownerId: "owner", environmentId: "env", threadId: "thread" };
function fixture(t, send = async () => {}) {
  const dir = mkdtempSync(join(tmpdir(), "t3-incoming-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "calls.json");
  let now = 1000;
  const options = { send, now: () => now };
  const calls = new IncomingCalls(file, options);
  calls.register("owner", pushDevice());
  return { calls, reopen: () => new IncomingCalls(file, options), advance: (ms) => (now += ms) };
}
test("a push acceptance does not claim the user answered; duplicate requests do not ring twice", async (t) => {
  const deliveries = [];
  const f = fixture(t, async (...args) => deliveries.push(args));
  const result = await f.calls.request(target, "Ready", "Results");
  assert.equal(result.status, "ring_requested");
  assert.equal((await f.calls.request(target, "Again", "")).status, "busy");
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0][0].hostEnvironmentId, "host");
  assert.equal(f.reopen().get("owner", result.callId).threadId, "thread");
  assert.equal(f.calls.get("other-owner", result.callId), null);
});
test("accept is one-shot, bound to a durable invitation, and cannot be replayed after restart", async (t) => {
  const f = fixture(t);
  const { callId } = await f.calls.request(target, "Ready", "Context");
  const call = f.calls.transition("owner", callId, "connecting");
  assert.equal(call.context, "Context");
  assert.throws(() => f.calls.transition("owner", callId, "connecting"));
  assert.equal(f.reopen().get("owner", callId).status, "ended");
});
test("late delivery and declined calls cannot be answered", async (t) => {
  const f = fixture(t);
  const first = await f.calls.request(target, "Ready", "");
  f.advance(45_000);
  assert.equal(f.calls.get("owner", first.callId).status, "missed");
  assert.throws(() => f.calls.transition("owner", first.callId, "connecting"));
  const second = await f.calls.request(target, "Ready", "");
  f.calls.transition("owner", second.callId, "declined");
  assert.throws(() => f.calls.transition("owner", second.callId, "connecting"));
});
test("push failures and absent device configuration never claim to ring", async (t) => {
  const f = fixture(t, async () => {
    throw Error("offline");
  });
  const result = await f.calls.request(target, "Ready", "");
  assert.equal(result.status, "unavailable");
  assert.equal(f.calls.get("owner", result.callId).status, "failed");
  assert.equal(
    (await f.calls.request({ ...target, ownerId: "other" }, "Ready", "")).status,
    "unavailable",
  );
});

test("expired push subscriptions are retired until the phone registers again", async (t) => {
  let deliveries = 0;
  const f = fixture(t, async () => {
    deliveries++;
    throw Object.assign(Error("subscription expired"), { status: 410 });
  });
  assert.equal((await f.calls.request(target, "Ready", "")).status, "unavailable");
  assert.equal((await f.reopen().request(target, "Retry", "")).status, "unavailable");
  assert.equal(deliveries, 1);
  f.calls.register("owner", pushDevice());
  await f.calls.request(target, "Registered again", "");
  assert.equal(deliveries, 2);
});
