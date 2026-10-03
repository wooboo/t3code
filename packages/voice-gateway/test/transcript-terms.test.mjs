import NodeAssert from "node:assert/strict";
import NodeTest from "node:test";
import { applyTranscriptTerms, rewritingSTT } from "../src/transcript-terms.mjs";

const terms = [
  { from: "brazilowskie", to: "Brazilianskie" },
  { from: "kioxia zawsze", to: "KIOXIA zawsze" },
];

NodeTest.test("applyTranscriptTerms rewrites phrases case-insensitively", () => {
  NodeAssert.equal(
    applyTranscriptTerms("Sluchamy BRAZILOWSKIE imie", terms),
    "Sluchamy Brazilianskie imie",
  );
});

NodeTest.test("applyTranscriptTerms prefers the longest key first", () => {
  NodeAssert.equal(
    applyTranscriptTerms("powtarzam: KIOXIA ZAWSZE", terms),
    "powtarzam: KIOXIA zawsze",
  );
});

NodeTest.test("applyTranscriptTerms keeps text unchanged without terms", () => {
  NodeAssert.equal(applyTranscriptTerms("abc", []), "abc");
  NodeAssert.equal(applyTranscriptTerms("abc", undefined), "abc");
});

NodeTest.test("rewriting transcript stream adapter rewrites delivered events", async () => {
  class ValueSTT {
    stream() {
      const self = this;
      return {
        async next() {
          return {
            done: false,
            value: {
              type: 2,
              alternatives: [{ text: "sluchamy KIOXIA ZAWSZE", confidence: 1 }],
            },
          };
        },
      };
    }
  }
  const Rewritten = rewritingSTT(ValueSTT, terms);
  const stream = new Rewritten({}).stream();
  const event = (await stream.next()).value;
  NodeAssert.equal(event.alternatives[0].text, "sluchamy KIOXIA zawsze");
});

NodeTest.test("rewriting is skipped entirely when the map is empty", () => {
  class Base {}
  NodeAssert.equal(rewritingSTT(Base, []), Base);
});
