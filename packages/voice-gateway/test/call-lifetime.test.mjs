import { test } from "node:test";
import assert from "node:assert/strict";
import { callLifetime } from "../prototype/call-lifetime.mjs";

test("connected calls survive thirty minutes, lost callers expire after a reconnect grace period", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let closed = 0;
  const lifetime = callLifetime({ close: () => closed++ });
  lifetime.connected();
  t.mock.timers.tick(2 * 3600_000);
  assert.equal(closed, 0);
  lifetime.disconnected();
  t.mock.timers.tick(59_999);
  lifetime.connected();
  t.mock.timers.tick(60_000);
  assert.equal(closed, 0);
  lifetime.disconnected();
  t.mock.timers.tick(60_000);
  assert.equal(closed, 1);
});
test("abandoned joins expire and explicit hangup cancels the timer", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let closed = 0;
  callLifetime({ close: () => closed++ });
  callLifetime({ close: () => closed++ }).close();
  t.mock.timers.tick(60_000);
  assert.equal(closed, 1);
});
