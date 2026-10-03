import { realpath } from "node:fs/promises";

export function installAgentSessionRoutes(app, { agent, taskManager, contexts, config }) {
  const guard = (req) => {
    // Native ACP history has no tenant ownership metadata. Do not expose a shared
    // machine's history to arbitrary identities if multi-user mode is enabled.
    if (config.identityMode !== "personal")
      throw Object.assign(new Error("Katalog sesji jest dostępny tylko w trybie osobistym"), {
        status: 403,
      });
    return req.identity.ownerId;
  };
  app.get("/api/agent-sessions", async (req, res, next) => {
    try {
      const owner = guard(req);
      const sessions = await agent.listNativeSessions({ limit: 500 });
      const needle = String(req.query.q || "").toLowerCase();
      const bindings = contexts.list(owner);
      res.json({
        sessions: sessions
          .filter((s) => s.sessionId && s.cwd)
          .filter((s) => `${s.title || ""} ${s.cwd} ${s.sessionId}`.toLowerCase().includes(needle))
          .map((s) => ({
            id: s.sessionId,
            title: String(s.title || s.sessionId)
              .replace(/\s+/g, " ")
              .slice(0, 200),
            directory: s.cwd,
            updatedAt: s.updatedAt || null,
            voiceSessionId:
              bindings.find((b) => b.agentSessionId === s.sessionId)?.voiceSessionId || null,
          })),
        limit: 500,
      });
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/voice-context", (req, res, next) => {
    try {
      res.json({ context: contexts.get(guard(req), String(req.query.sessionId || "")) });
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/voice-context", async (req, res, next) => {
    try {
      const owner = guard(req);
      const id = req.body?.agentSessionId,
        from = req.body?.fromVoiceSessionId;
      if (typeof id !== "string" || !id || typeof from !== "string" || !from)
        return res.status(400).json({ error: "Wymagane identyfikatory sesji" });
      if (taskManager.list({ ownerId: owner, sessionId: from, active: true }).length)
        return res
          .status(409)
          .json({ error: "Zaczekaj na zakończenie zadania lub anuluj je przed zmianą kontekstu" });
      const sessions = await agent.listNativeSessions({ limit: 500 });
      const selected = sessions.find((s) => s.sessionId === id && s.cwd);
      if (!selected)
        return res.status(404).json({ error: "Sesja nie jest dostępna w katalogu ACP" });
      const existing = contexts.list(owner).find((c) => c.agentSessionId === id);
      if (
        existing &&
        taskManager.list({ ownerId: owner, sessionId: existing.voiceSessionId, active: true })
          .length
      )
        return res.status(409).json({ error: "Ta sesja wykonuje już zadanie" });
      const cwd = await realpath(selected.cwd);
      res.json({ context: contexts.bind(owner, { ...selected, cwd }) });
    } catch (error) {
      next(error);
    }
  });
}
