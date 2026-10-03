function key(ownerId, sessionId) {
  return `${String(ownerId || "")}\u0000${String(sessionId || "main")}`;
}

export class SessionPermissionPolicy {
  constructor({ maxSessions = 500, ttlMs = 6 * 60 * 60 * 1000, now = () => Date.now() } = {}) {
    this.maxSessions = maxSessions;
    this.ttlMs = ttlMs;
    this.now = now;
    this.sessions = new Map();
  }

  prune() {
    const now = this.now();
    for (const [id, state] of this.sessions) {
      if (now - state.updatedAt >= this.ttlMs) this.sessions.delete(id);
    }
    while (this.sessions.size > this.maxSessions) {
      const oldest = [...this.sessions.entries()].sort(
        (left, right) => left[1].updatedAt - right[1].updatedAt,
      )[0];
      if (!oldest) break;
      this.sessions.delete(oldest[0]);
    }
  }

  mode(ownerId, sessionId) {
    this.prune();
    return this.sessions.get(key(ownerId, sessionId))?.mode || "ask";
  }

  setMode(ownerId, sessionId, mode) {
    const normalized = mode === "auto_allow" ? "auto_allow" : "ask";
    this.sessions.set(key(ownerId, sessionId), {
      mode: normalized,
      updatedAt: this.now(),
    });
    this.prune();
    return normalized;
  }

  applyDecision(ownerId, sessionId, decision) {
    return this.setMode(ownerId, sessionId, decision === "always" ? "auto_allow" : "ask");
  }

  shouldAutoAllow(ownerId, sessionId) {
    return this.mode(ownerId, sessionId) === "auto_allow";
  }
}
