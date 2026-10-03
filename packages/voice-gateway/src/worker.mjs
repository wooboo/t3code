import { parentPort, workerData } from "node:worker_threads";
import { createT3VoiceGateway } from "./runtime.mjs";

const pending = new Map();
let sequence = 0;
parentPort.on("message", (message) => {
  if (message.type !== "token") return;
  const request = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) request?.reject(new Error(message.error));
  else request?.resolve(message.token);
});
const gateway = await createT3VoiceGateway({
  ...workerData,
  token: () =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      parentPort.postMessage({ type: "token", id });
    }),
});
parentPort.on("message", async (message) => {
  if (message.type !== "close") return;
  await gateway.close();
  parentPort.close();
});
parentPort.postMessage({ type: "ready", origin: gateway.origin });
