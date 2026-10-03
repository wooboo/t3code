import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { TurnMeter, summarize } from "./metrics.mjs";
import { livekitPrototypeConfig, publicPrototypeConfig } from "./config.mjs";

NodeTest.test(
  "both transports measure from the last speech frame, excluding silence and short clicks",
  () => {
    const events = [];
    const meter = new TurnMeter((event) => events.push(event));
    meter.input(0.1, 0);
    meter.input(0, 40);
    meter.output(0.1, 500);
    NodeAssert.equal(events.length, 0);
    for (const at of [1000, 1040, 1080, 1120, 1160]) meter.input(0.1, at);
    meter.output(0, 1400);
    meter.output(0.1, 1660);
    meter.output(0.1, 1800);
    NodeAssert.equal(events.length, 1);
    NodeAssert.equal(events[0].responseMs, 500);
  },
);

NodeTest.test(
  "unanswered turns and failed runs are retained but not counted as zero-latency successes",
  () => {
    const events = [];
    const meter = new TurnMeter((event) => events.push(event));
    meter.input(0.1, 100);
    meter.input(0.1, 240);
    meter.finish();
    const result = summarize([{ variant: "livekit", events, error: "connection lost" }], "livekit");
    NodeAssert.deepEqual(result, {
      runs: 1,
      samples: 0,
      p50: null,
      p95: null,
      failedRuns: 1,
      unanswered: 1,
    });
  },
);

NodeTest.test(
  "credentials are never returned in comparison configuration and missing models stay explicit",
  () => {
    const settings = livekitPrototypeConfig({
      LIVEKIT_API_SECRET: "private-secret",
      VOICE_COMPARE_TTS_KEY: "private-tts",
    });
    const visible = publicPrototypeConfig(settings, { modelSelection: null }, { provider: "s2s" });
    NodeAssert.equal(visible.ready, false);
    NodeAssert.ok(visible.missing.includes("VOICE_COMPARE_STT_MODEL"));
    NodeAssert.doesNotMatch(JSON.stringify(visible), /private-secret|private-tts/);
    NodeAssert.equal(visible.livekit.sampleRate, 16000);
  },
);
