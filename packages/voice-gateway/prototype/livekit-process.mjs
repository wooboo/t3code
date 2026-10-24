import * as NodeCrypto from "node:crypto";
import { startLivekitPrototype } from "./livekit.mjs";
const pending = new Map();
let handle;
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  try {
    await handle?.close();
  } finally {
    process.exit(0);
  }
};
process.on("disconnect", () => void close());
process.on("SIGTERM", () => void close());
process.on("message", (message) => {
  if (message.type === "result") {
    const task = pending.get(message.id);
    if (task) {
      pending.delete(message.id);
      message.error ? task.reject(Error(message.error)) : task.resolve(message.result);
    }
  }
  if (message.type === "notify") {
    void Promise.resolve()
      .then(() => {
        if (!handle || closing) throw Error("Voice agent is unavailable");
        return handle.notify(message.message);
      })
      .then(
        () => {
          if (process.connected) process.send({ type: "notified", id: message.id });
        },
        () => {
          if (process.connected)
            process.send({ type: "notified", id: message.id, error: "Voice handoff failed" });
        },
      );
  }
  if (message.type === "close") void close();
  if (message.type === "start") {
    void startLivekitPrototype({
      ...message.options,
      onClose: () => void close(),
      onConnectionChange: (connected) => {
        if (process.connected) process.send({ type: "connection", connected });
      },
      onTranscript: (entry) => {
        if (process.connected) process.send({ type: "transcript", entry });
      },
      executor: {
        runSelectedSession: (_binding, { objective }) =>
          new Promise((resolve, reject) => {
            const id = NodeCrypto.randomUUID();
            pending.set(id, { resolve, reject });
            process.send({ type: "execute", id, objective });
          }),
      },
    })
      .then(async (result) => {
        handle = result;
        if (closing) {
          await handle.close();
          return;
        }
        const { close: _close, notify: _notify, ...connection } = handle;
        process.send({ type: "ready", handle: connection });
      })
      .catch((error) => {
        if (process.connected) process.send({ type: "error", error: error.message });
      });
  }
});
