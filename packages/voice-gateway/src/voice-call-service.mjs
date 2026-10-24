import { callUser, voiceCallKey } from "../prototype/call-user.mjs";
import * as NodeCrypto from "node:crypto";

/** Delegated work belongs to the gateway, so hanging up only stops its audio process. */
export class VoiceCallService {
  constructor({ incoming, getAutoCallback, recordResult = () => {} }) {
    this.incoming = incoming;
    this.getAutoCallback = getAutoCallback;
    this.recordResult = recordResult;
    this.sessions = new Map();
    this.starting = new Set();
    this.closed = false;
    this.targetRevisions = new Map();
  }

  request(target, reason, context = "") {
    if (this.closed) return Promise.resolve({ status: "unavailable" });
    return callUser({
      sessions: this.sessions,
      starting: this.starting,
      incoming: this.incoming,
      target,
      reason,
      context,
    });
  }

  async runDelegatedTask(target, execute, sourceSessionId) {
    const targetKey = JSON.stringify([target.ownerId, target.environmentId]);
    const revision = this.targetRevisions.get(targetKey);
    let result;
    let executionError;
    let executionFailed = false;
    try {
      result = await execute();
    } catch (error) {
      executionError = error;
      executionFailed = true;
      result = {
        failed: true,
        content:
          "Zadanie głosowe zakończyło się błędem albo upłynął czas oczekiwania. Sprawdź szczegóły w wątku T3.",
      };
    }
    const isCurrent = () => !this.closed && this.targetRevisions.get(targetKey) === revision;
    try {
      if (!this.closed && result.completed !== false) {
        const messageId = await this.#recordResult(target, result);
        if (isCurrent())
          await this.#taskCompleted(target, result, isCurrent, sourceSessionId, messageId);
      }
    } catch {
      console.warn("[voice-callback] Could not confirm task-result delivery.");
    }
    if (executionFailed) throw executionError;
    return result;
  }

  async #recordResult(target, result) {
    const messageId = result.runId
      ? `agent:${NodeCrypto.createHash("sha256")
          .update(JSON.stringify([voiceCallKey(target), result.runId]))
          .digest("hex")}`
      : `agent:${NodeCrypto.randomUUID()}`;
    try {
      await this.recordResult(target, result, messageId);
    } catch {
      console.warn("[voice-result] Could not persist task-result history.");
    }
    return messageId;
  }

  async #notifyResult(target, messageId) {
    try {
      await this.incoming?.notifyResult(target, messageId);
    } catch {
      console.warn("[voice-result] Could not confirm notification delivery.");
    }
  }

  async #taskCompleted(target, result, isCurrent, sourceSessionId, messageId) {
    const key = voiceCallKey(target);
    let session = [...this.sessions.values()].find((entry) => entry.key === key);
    const reason = result.failed
      ? "Zadanie zlecone podczas rozmowy wymaga uwagi."
      : "Zadanie zlecone podczas rozmowy jest gotowe.";
    const context = String(result.content || "Wynik znajdziesz w wątku T3.").slice(0, 8000);
    if (session && session.connected !== false) {
      // The originating process will speak after updating its task state. A replacement call
      // needs an explicit handoff because the original process can no longer deliver to it.
      if (session.id === sourceSessionId) return;
      return this.request(target, reason, context);
    }
    // A normal notification survives an unanswered call and does not depend on call opt-in.
    await this.#notifyResult(target, messageId);
    if (!isCurrent()) return { status: "unavailable" };
    session = [...this.sessions.values()].find((entry) => entry.key === key);
    if (session && session.connected !== false) {
      if (session.id === sourceSessionId) return;
      return this.request(target, reason, context);
    }
    if (!this.getAutoCallback(target.ownerId)) return { status: "unavailable" };
    // LiveKit retains disconnected rooms briefly for reconnection. Release that room before
    // requesting a new invitation, otherwise the old call would keep reporting busy.
    if (session) await session.close();
    if (!isCurrent() || !this.getAutoCallback(target.ownerId)) return { status: "unavailable" };
    return this.request(target, reason, context);
  }

  closeTarget(ownerId, environmentId) {
    const key = JSON.stringify([ownerId, environmentId]);
    this.targetRevisions.set(key, (this.targetRevisions.get(key) ?? 0) + 1);
    return Promise.allSettled(
      [...this.sessions.values()]
        .filter((session) => session.ownerId === ownerId && session.environmentId === environmentId)
        .map((session) => session.close()),
    );
  }

  close() {
    this.closed = true;
    return Promise.allSettled([...this.sessions.values()].map((session) => session.close()));
  }
}
