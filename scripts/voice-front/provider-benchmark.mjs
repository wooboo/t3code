import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

/** Sequential, bounded full-response measurements. These are deliberately not called TTFT. */
export async function benchmarkProviders({
  origin,
  token,
  models,
  samples = 1,
  timeoutMs = 30_000,
  fetchImpl = fetch,
}) {
  if (!Array.isArray(models) || models.length < 1 || models.length > 8)
    throw new Error(
      "Choose 1–8 models explicitly; never benchmark the entire catalogue implicitly.",
    );
  if (!Number.isInteger(samples) || samples < 1 || samples > 3)
    throw new Error("Samples must be between 1 and 3.");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 90_000)
    throw new Error("Timeout must be between 100 and 90000 ms.");
  const results = [];
  for (const modelSelection of models) {
    if (!modelSelection?.instanceId || !modelSelection?.model)
      throw new Error("Every model needs instanceId and model.");
    for (let sample = 0; sample < samples; sample += 1) {
      const start = performance.now();
      try {
        const response = await fetchImpl(new URL("/api/voice/respond", origin), {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            modelSelection,
            prompt: "User: Powiedz tylko „Gotowe”. No tools are available.",
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const output = await response.json();
        if (typeof output.text !== "string" || !Array.isArray(output.toolCalls))
          throw new Error("Invalid response envelope");
        results.push({
          modelSelection,
          sample: sample + 1,
          ok: true,
          fullResponseMs: Math.round(performance.now() - start),
          serverElapsedMs: output.elapsedMs,
          ttftMs: null,
          streaming: false,
        });
      } catch (error) {
        results.push({
          modelSelection,
          sample: sample + 1,
          ok: false,
          fullResponseMs: Math.round(performance.now() - start),
          ttftMs: null,
          streaming: false,
          error: error.name === "TimeoutError" ? "timeout" : error.message,
        });
      }
    }
  }
  return results;
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  // The explicit input file avoids accidentally spending subscription usage on every discovered model.
  const modelFile = process.argv[2];
  if (!modelFile || !process.env.T3_VOICE_TOKEN_FILE)
    throw new Error(
      "Usage: T3_VOICE_TOKEN_FILE=<file> node provider-benchmark.mjs <model-selections.json> [samples]",
    );
  const results = await benchmarkProviders({
    origin: process.env.T3_VOICE_ORIGIN || "http://127.0.0.1:13773",
    token: (await NodeFSP.readFile(process.env.T3_VOICE_TOKEN_FILE, "utf8")).trim(),
    models: JSON.parse(await NodeFSP.readFile(modelFile, "utf8")),
    samples: Number(process.argv[3] || "1"),
  });
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
}
