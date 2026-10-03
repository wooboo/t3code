import { Worker } from "node:worker_threads";

/** Owns one gateway worker, including bounded startup and graceful shutdown. */
export async function startVoiceGateway({
  workerUrl = new URL("./worker.mjs", import.meta.url),
  getToken,
  ...options
}) {
  const worker = new Worker(workerUrl, { workerData: options });
  let closed = false;
  let closePromise;
  const exited = new Promise((resolve) =>
    worker.once("exit", () => {
      closed = true;
      resolve();
    }),
  );
  const close = () =>
    (closePromise ||= (async () => {
      if (closed) return;
      worker.postMessage({ type: "close" });
      const timeout = setTimeout(() => void worker.terminate(), 5000);
      try {
        await exited;
      } finally {
        clearTimeout(timeout);
      }
    })());
  worker.on("message", (message) => {
    if (message.type !== "token") return;
    void Promise.resolve()
      .then(getToken)
      .then(
        (token) => worker.postMessage({ type: "token", id: message.id, token }),
        () =>
          worker.postMessage({
            type: "token",
            id: message.id,
            error: "T3 voice authorization unavailable",
          }),
      );
  });
  try {
    const origin = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Voice gateway startup timed out")), 15000);
      worker.once("error", reject);
      worker.once("exit", () => reject(new Error("Voice gateway exited before ready")));
      worker.on("message", (message) => {
        if (message.type === "ready") {
          clearTimeout(timeout);
          resolve(message.origin);
        }
      });
      exited.then(() => clearTimeout(timeout));
    });
    return {
      origin,
      close,
      get closed() {
        return closed;
      },
    };
  } catch (error) {
    await worker.terminate();
    throw error;
  }
}
