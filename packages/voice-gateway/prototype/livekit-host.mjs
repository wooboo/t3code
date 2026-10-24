import { randomUUID } from "node:crypto";
import * as NodeChildProcess from "node:child_process";

// The RTC native addon owns process-global callbacks. Keep it outside T3's
// gateway worker so closing a call cannot invalidate callbacks in that worker.
export async function startLivekitPrototype({
  executor,
  onClose,
  onTranscript,
  onConnectionChange,
  ...options
}) {
  const child = NodeChildProcess.fork(new URL("./livekit-process.mjs", import.meta.url), [], {
    execArgv: [],
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  const notifications = new Map();
  let closed = false;
  let stopTimer;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const close = async () => {
    if (!closed) {
      closed = true;
      onConnectionChange?.(false);
      if (child.connected) child.send({ type: "close" });
      stopTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
    }
    await exited;
  };
  child.once("exit", () => {
    closed = true;
    for (const pending of notifications.values()) pending.reject(Error("Voice process exited"));
    notifications.clear();
    clearTimeout(stopTimer);
    onConnectionChange?.(false);
    onClose();
  });
  child.on("message", (message) => {
    if (message.type === "connection" && !closed) {
      onConnectionChange?.(message.connected);
      return;
    }
    if (message.type === "notified") {
      const pending = notifications.get(message.id);
      if (pending) {
        notifications.delete(message.id);
        message.error ? pending.reject(Error(message.error)) : pending.resolve();
      }
      return;
    }
    if (message.type === "transcript" && !closed) {
      onTranscript?.(message.entry);
      return;
    }
    if (message.type !== "execute" || closed) return;
    void executor
      .runSelectedSession(
        options.binding,
        { objective: message.objective },
        { ownerId: options.binding.ownerId },
      )
      .then(
        (result) => ({ result }),
        () => ({ error: "Sprawdź zadanie w T3." }),
      )
      .then((result) => {
        if (!closed && child.connected)
          child.send({ type: "result", id: message.id, ...result }, () => {});
      });
  });
  try {
    const handle = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("LiveKit startup timed out")), 45000);
      child.once("error", reject);
      child.once("exit", () => {
        clearTimeout(timer);
        reject(Error("LiveKit process exited"));
      });
      child.on("message", (message) => {
        if (message.type === "ready") {
          clearTimeout(timer);
          resolve(message.handle);
        }
        if (message.type === "error") {
          clearTimeout(timer);
          reject(Error(message.error));
        }
      });
      child.send({ type: "start", options });
    });
    const notify = (message) =>
      new Promise((resolve, reject) => {
        if (closed || !child.connected) {
          reject(Error("Voice process is unavailable"));
          return;
        }
        const id = randomUUID();
        const timer = setTimeout(() => {
          notifications.delete(id);
          reject(Error("Voice handoff timed out"));
        }, 5000);
        notifications.set(id, {
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        child.send({ type: "notify", id, message }, (error) => {
          if (error) {
            notifications.get(id)?.reject(error);
            notifications.delete(id);
          }
        });
      });
    return { ...handle, close, notify };
  } catch (error) {
    await close();
    throw error;
  }
}
