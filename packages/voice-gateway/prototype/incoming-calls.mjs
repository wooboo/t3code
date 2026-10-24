import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { validateCallbackDevice } from "./call-push.mjs";

/** One phone per personal voice host. Persist invitations, never LiveKit credentials. */
export class IncomingCalls {
  constructor(file, { send, now = Date.now } = {}) {
    this.file = file;
    this.send = send;
    this.now = now;
    this.state = NodeFS.existsSync(file)
      ? JSON.parse(NodeFS.readFileSync(file, "utf8"))
      : { devices: {}, calls: {} };
    for (const call of Object.values(this.state.calls))
      if (call.status === "connecting" || call.status === "accepted") call.status = "ended";
    // Discard registrations that no longer match a supported device schema.
    for (const [owner, device] of Object.entries(this.state.devices)) {
      try {
        this.state.devices[owner] = validateCallbackDevice(device);
      } catch {
        delete this.state.devices[owner];
      }
    }
    this.save();
  }
  save() {
    const cutoff = this.now() - 86400_000;
    for (const [id, call] of Object.entries(this.state.calls))
      if (call.expiresAt < cutoff) delete this.state.calls[id];
    NodeFS.mkdirSync(NodePath.dirname(this.file), { recursive: true, mode: 0o700 });
    NodeFS.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.state), { mode: 0o600 });
    NodeFS.renameSync(`${this.file}.tmp`, this.file);
  }
  register(ownerId, device) {
    this.state.devices[ownerId] = validateCallbackDevice(device);
    this.save();
  }
  unregister(ownerId, deviceId) {
    if (this.state.devices[ownerId]?.deviceId !== deviceId) return;
    delete this.state.devices[ownerId];
    this.save();
  }
  get(ownerId, id) {
    const call = this.state.calls[id];
    if (!call || call.ownerId !== ownerId) return null;
    if (call.status === "pending" && call.expiresAt <= this.now()) {
      call.status = "missed";
      this.save();
    }
    return { ...call };
  }
  transition(ownerId, id, status) {
    const call = this.get(ownerId, id);
    if (!call || call.status !== "pending") throw Error("This call is no longer ringing");
    this.state.calls[id].status = status;
    this.save();
    return call;
  }
  finish(ownerId, id, status) {
    if (this.get(ownerId, id)) {
      this.state.calls[id].status = status;
      this.save();
    }
  }
  async request(target, reason, context) {
    const device = this.state.devices[target.ownerId];
    if (!this.send || !device || (this.send.supports && !this.send.supports(device)))
      return {
        status: "unavailable",
        message: "No callback phone or push sender is configured. No call was placed.",
      };
    for (const saved of Object.values(this.state.calls)) {
      const call = this.get(target.ownerId, saved.id);
      if (call?.status === "pending" || call?.status === "connecting")
        return {
          status: "busy",
          callId: call.id,
          message: "A callback is already pending. Do not retry automatically.",
        };
    }
    const call = {
      id: NodeCrypto.randomUUID(),
      ownerId: target.ownerId,
      environmentId: target.environmentId,
      threadId: target.threadId,
      reason,
      context,
      status: "pending",
      expiresAt: this.now() + 45_000,
    };
    this.state.calls[call.id] = call;
    this.save();
    try {
      await this.send(device, { callId: call.id, expiresAt: String(call.expiresAt) });
      return {
        status: "ring_requested",
        callId: call.id,
        message:
          "Push accepted; the phone has not confirmed an answer. Do not assume the user heard you.",
      };
    } catch (error) {
      if ([404, 410].includes(error?.status) && this.state.devices[target.ownerId] === device)
        delete this.state.devices[target.ownerId];
      this.finish(target.ownerId, call.id, "failed");
      return {
        status: "unavailable",
        callId: call.id,
        message: "Push delivery could not be confirmed. Do not retry automatically.",
      };
    }
  }

  async notifyResult(target, messageId) {
    const device = this.state.devices[target.ownerId];
    if (!this.send || !device || (this.send.supports && !this.send.supports(device))) return;
    try {
      await this.send(
        device,
        {
          messageId,
          environmentId: target.environmentId,
          threadId: target.threadId,
          createdAt: String(this.now()),
        },
        { kind: "voice_result", ttlSeconds: 86400 },
      );
    } catch (error) {
      if ([404, 410].includes(error?.status) && this.state.devices[target.ownerId] === device) {
        delete this.state.devices[target.ownerId];
        this.save();
      }
      console.warn("[voice-result] Could not confirm notification delivery.");
    }
  }
}
