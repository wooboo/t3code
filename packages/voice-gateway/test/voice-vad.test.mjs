import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeModule from "node:module";
import { VADEventType } from "@livekit/agents";
import { AudioFrame } from "@livekit/rtc-node";
import { createVoiceVad } from "../prototype/livekit.mjs";

const requireSilero = NodeModule.createRequire(
  import.meta.resolve("@livekit/agents-plugin-silero"),
);
const { InferenceSession } = requireSilero("onnxruntime-node");

// Control model confidence, but exercise the real Silero stream, smoothing,
// speech boundaries and the same detector factory used by the call session.
async function detect(t, probabilities, silenceMs = 500) {
  let index = 0;
  const mock = t.mock.method(InferenceSession, "create", async () => ({
    run: async () => ({
      output: { data: Float32Array.of(probabilities[index++]) },
      stateN: { data: new Float32Array(256) },
    }),
  }));
  const vad = await createVoiceVad(silenceMs);
  mock.mock.restore();
  const stream = vad.stream();
  const events = [];
  try {
    for (const _probability of probabilities) {
      stream.pushFrame(new AudioFrame(new Int16Array(512), 16000, 1, 512));
    }
    // The last inference event proves all preceding speech boundaries were read.
    for await (const event of stream) {
      events.push(event);
      if (
        event.type === VADEventType.INFERENCE_DONE &&
        event.samplesIndex === probabilities.length * 512
      )
        break;
    }
    return events;
  } finally {
    stream.close();
    await vad.close();
  }
}

NodeTest.test("ambiguous input does not activate speech", async (t) => {
  const events = await detect(t, Array(12).fill(0.6));
  NodeAssert.equal(events.filter((event) => event.type === VADEventType.START_OF_SPEECH).length, 0);
});

NodeTest.test(
  "clear speech still starts promptly and ends after the configured silence",
  async (t) => {
    const events = await detect(t, [...Array(10).fill(0.95), ...Array(22).fill(0)]);
    const starts = events.filter((event) => event.type === VADEventType.START_OF_SPEECH);
    const ends = events.filter((event) => event.type === VADEventType.END_OF_SPEECH);
    NodeAssert.equal(starts.length, 1);
    NodeAssert.equal(starts[0].timestamp, 64);
    NodeAssert.equal(ends.length, 1);
    NodeAssert.ok(ends[0].silenceDuration > 500);
    NodeAssert.ok(ends[0].silenceDuration <= 532);
  },
);
