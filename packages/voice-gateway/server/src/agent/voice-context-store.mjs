import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

// Bindings are immutable: a voice conversation can never silently change executor.
export class VoiceContextStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.entries = null;
  }
  load() {
    if (this.entries) return;
    const entries = existsSync(this.filePath)
      ? JSON.parse(readFileSync(this.filePath, "utf8")).contexts
      : [];
    if (!Array.isArray(entries)) throw new Error("Invalid voice context store");
    this.entries = entries;
  }
  list(ownerId) {
    this.load();
    return this.entries.filter((e) => e.ownerId === ownerId).map((e) => ({ ...e }));
  }
  get(ownerId, voiceSessionId) {
    this.load();
    return (
      this.entries.find((e) => e.ownerId === ownerId && e.voiceSessionId === voiceSessionId) || null
    );
  }
  bind(ownerId, session) {
    if (!ownerId || !session.sessionId || !session.cwd)
      throw new Error("Incomplete session binding");
    const prior = this.list(ownerId).find((e) => e.agentSessionId === session.sessionId);
    if (prior) return prior;
    const entry = {
      ownerId,
      voiceSessionId: `acp_${randomUUID()}`,
      agentSessionId: session.sessionId,
      title: String(session.title || session.sessionId).slice(0, 200),
      directory: session.cwd,
      createdAt: Date.now(),
    };
    const next = [...this.entries, entry];
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify({ version: 1, contexts: next }, null, 2), { mode: 0o600 });
    renameSync(temp, this.filePath);
    this.entries = next;
    return entry;
  }
}
