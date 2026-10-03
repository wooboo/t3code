import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { createVoiceSentenceTokenizer } from "../prototype/voice-sentence-tokenizer.mjs";

NodeTest.test(
  "a complete short acknowledgement is emitted while the model is still generating tools",
  async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const stream = createVoiceSentenceTokenizer().stream();
    let first;
    const pending = stream.next().then((result) => {
      first = result;
    });
    try {
      stream.pushText("Już sprawdzam.");
      t.mock.timers.tick(150);
      await new Promise(setImmediate);
      NodeAssert.equal(first?.value.token, "Już sprawdzam.");
      stream.pushText("Zaraz wrócę z wynikiem.");
      stream.endInput();
      const rest = [];
      for await (const token of stream) rest.push(token.token);
      NodeAssert.deepEqual(rest, ["Zaraz wrócę z wynikiem."]);
    } finally {
      stream.close();
      await pending;
    }
  },
);

NodeTest.test("unfinished text and decimal numbers remain buffered across pauses", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const [prefix, suffix, expected] of [
    ["Jeszcze", " sprawdzam.", "Jeszcze sprawdzam."],
    ["Wersja 3.", "14 jest gotowa.", "Wersja 3.14 jest gotowa."],
    ["Zapytam Dr.", " Smitha.", "Zapytam Dr. Smitha."],
  ]) {
    const stream = createVoiceSentenceTokenizer().stream();
    let received = false;
    const first = stream.next().then((result) => {
      received = true;
      return result;
    });
    stream.pushText(prefix);
    t.mock.timers.tick(1000);
    await new Promise(setImmediate);
    NodeAssert.equal(received, false);
    stream.pushText(suffix);
    stream.endInput();
    NodeAssert.equal((await first).value.token, expected);
    stream.close();
  }
});

NodeTest.test("closing an interrupted stream cancels its pending sentence flush", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const stream = createVoiceSentenceTokenizer().stream();
  stream.pushText("Już sprawdzam.");
  stream.close();
  NodeAssert.doesNotThrow(() => t.mock.timers.tick(1000));
});
