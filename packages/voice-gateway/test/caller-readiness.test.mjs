import { test } from "node:test";
import assert from "node:assert/strict";
import { callerReadiness } from "../prototype/caller-readiness.mjs";

function fixture(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const asked = [];
  let interruptions = 0;
  const call = callerReadiness({
    ask: (text) => asked.push(text),
    interrupt: () => interruptions++,
  });
  return { call, asked, interruptions: () => interruptions };
}
test("waits for connection then asks once after three seconds of silence", (t) => {
  const f = fixture(t);
  t.mock.timers.tick(10000);
  assert.deepEqual(f.asked, []);
  f.call.connected();
  t.mock.timers.tick(2999);
  assert.deepEqual(f.asked, []);
  t.mock.timers.tick(1);
  assert.deepEqual(f.asked, ["Jest tam kto?"]);
  t.mock.timers.tick(60000);
  assert.equal(f.asked.length, 1);
});
test("any recognized speech cancels the prompt, including partial transcription", (t) => {
  const f = fixture(t);
  f.call.connected();
  t.mock.timers.tick(1000);
  f.call.speaking(true);
  f.call.transcript("Słucham");
  f.call.speaking(false);
  t.mock.timers.tick(10000);
  assert.deepEqual(f.asked, []);
});
test("noise without recognized words does not establish readiness", (t) => {
  const f = fixture(t);
  f.call.connected();
  f.call.speaking(true);
  f.call.transcript(" ");
  t.mock.timers.tick(3000);
  assert.deepEqual(f.asked, []);
  f.call.speaking(false);
  t.mock.timers.tick(3000);
  assert.deepEqual(f.asked, ["Jest tam kto?"]);
  f.call.speaking(true);
  assert.equal(f.interruptions(), 1);
});
test("hanging up cancels the silence prompt", (t) => {
  const f = fixture(t);
  f.call.connected();
  f.call.close();
  t.mock.timers.tick(3000);
  assert.deepEqual(f.asked, []);
});
