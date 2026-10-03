import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";

/** Persist the gateway's bounded history, keeping it out of executor turn dispatch. */
export function persistentConversationSync(Base, directory) {
  return new (class extends Base {
    file(ownerId, sessionId) {
      const key = createHash("sha256")
        .update(JSON.stringify([ownerId, sessionId]))
        .digest("hex");
      return path.join(directory, key + ".json");
    }
    state(ownerId, sessionId) {
      const existing = super.peek(ownerId, sessionId);
      if (existing) return existing;
      const state = super.state(ownerId, sessionId);
      try {
        const messages = JSON.parse(fs.readFileSync(this.file(ownerId, sessionId), "utf8")).slice(
          -this.maxMessages,
        );
        state.messages = messages;
        state.byId = new Map(messages.map((m) => [m.id, m]));
        this.sequence = Math.max(this.sequence, ...messages.map((m) => m.seq || 0));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      return state;
    }
    persist(ownerId, sessionId) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const file = this.file(ownerId, sessionId);
      const temp = file + "." + randomUUID();
      fs.writeFileSync(temp, JSON.stringify(this.state(ownerId, sessionId).messages), {
        mode: 0o600,
      });
      fs.renameSync(temp, file);
    }
    list({ ownerId, sessionId }) {
      this.state(ownerId, sessionId);
      return super.list({ ownerId, sessionId });
    }
    record(input) {
      const result = super.record(input);
      if (result) this.persist(input.ownerId, input.sessionId);
      return result;
    }
  })();
}
