// Both transports use these client-clock measurements. They estimate audio onset,
// not physical speaker latency or the model's TTFT.
export class TurnMeter {
  constructor(report, { inputThreshold = 0.025, outputThreshold = 0.008 } = {}) {
    this.report = report;
    this.inputThreshold = inputThreshold;
    this.outputThreshold = outputThreshold;
    this.inputStart = null;
    this.lastInput = null;
    this.lastOutput = null;
    this.pending = null;
    this.interruption = null;
    this.turns = [];
    this.interruptions = [];
  }
  input(level, now) {
    if (level >= this.inputThreshold) {
      if (this.lastInput === null || now - this.lastInput > 300) this.inputStart = now;
      this.lastInput = now;
      if (now - this.inputStart >= 120 && !this.pending) {
        this.pending = { speechStartMs: this.inputStart, speechEndMs: now, responseMs: null };
        if (this.lastOutput !== null && now - this.lastOutput < 180)
          this.interruption = { speechStartMs: this.inputStart, outputEndMs: this.lastOutput };
      }
      if (this.pending) this.pending.speechEndMs = now;
    }
    this.tick(now);
  }
  output(level, now) {
    if (level >= this.outputThreshold) {
      this.lastOutput = now;
      if (this.interruption) this.interruption.outputEndMs = now;
      if (this.pending && now - this.pending.speechEndMs >= 200) {
        const turn = {
          ...this.pending,
          firstOutputMs: now,
          responseMs: now - this.pending.speechEndMs,
          outcome: "audio",
        };
        this.turns.push(turn);
        this.pending = null;
        this.report({ type: "turn", ...turn });
      }
    }
    this.tick(now);
  }
  tick(now) {
    if (this.interruption && now - this.interruption.outputEndMs > 180) {
      const interruption = {
        ...this.interruption,
        stopMs: Math.max(0, this.interruption.outputEndMs - this.interruption.speechStartMs),
      };
      this.interruption = null;
      this.interruptions.push(interruption);
      this.report({ type: "interruption", ...interruption });
    }
  }
  finish() {
    if (this.pending) {
      const turn = { ...this.pending, outcome: "no-audio-before-stop" };
      this.turns.push(turn);
      this.report({ type: "turn", ...turn });
      this.pending = null;
    }
  }
}

export function summarize(runs, variant) {
  const selected = runs.filter((run) => run.variant === variant);
  const values = selected
    .flatMap((run) => run.events)
    .filter((event) => event.type === "turn" && event.outcome === "audio")
    .map((event) => event.responseMs)
    .sort((a, b) => a - b);
  const percentile = (p) => (values.length ? values[Math.ceil(values.length * p) - 1] : null);
  return {
    runs: selected.length,
    samples: values.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    failedRuns: selected.filter((run) => run.error).length,
    unanswered: selected
      .flatMap((run) => run.events)
      .filter((e) => e.outcome === "no-audio-before-stop").length,
  };
}
