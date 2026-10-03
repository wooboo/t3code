import { test } from "node:test";
import assert from "node:assert/strict";
import { callUser, voiceCallKey } from "../prototype/call-user.mjs";
const target = { ownerId: "user", environmentId: "env", threadId: "thread" };
function fixture() {
  const delivered = [];
  const session = {
    id: "call",
    key: voiceCallKey(target),
    ownerId: target.ownerId,
    notify: async (message) => delivered.push(message),
  };
  return {
    delivered,
    session,
    input: {
      sessions: new Map([[session.id, session]]),
      starting: new Set(),
      target,
      reason: "Results ready",
      context: "Tests passed",
    },
  };
}
test("hands off to the voice agent in exactly the originating thread", async () => {
  const f = fixture();
  assert.deepEqual(await callUser(f.input), { status: "delivered_to_voice_agent", callId: "call" });
  assert.deepEqual(f.delivered, [{ reason: "Results ready", context: "Tests passed" }]);
});
test("does not cross environments or threads", async () => {
  for (const other of [
    { ...target, threadId: "other" },
    { ...target, environmentId: "other" },
  ]) {
    const f = fixture();
    assert.equal((await callUser({ ...f.input, target: other })).status, "busy");
    assert.deepEqual(f.delivered, []);
  }
});
test("does not claim delivery if the voice process rejects the handoff", async () => {
  const f = fixture();
  f.session.notify = async () => {
    throw Error("disconnected");
  };
  await assert.rejects(callUser(f.input), /disconnected/);
});
test("reports unavailable without configured push and reports connecting separately", async () => {
  const f = fixture();
  f.input.sessions.clear();
  assert.equal((await callUser(f.input)).status, "unavailable");
  f.input.starting.add(voiceCallKey(target));
  assert.equal((await callUser(f.input)).status, "connecting");
});
