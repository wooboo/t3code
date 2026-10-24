import { voiceCallKey } from "./call-user.mjs";
import { VoiceCallService } from "../src/voice-call-service.mjs";
import { mountAgentSettings } from "./agent-settings.mjs";
import * as NodeURL from "node:url";
import * as NodeModule from "node:module";
import { livekitPrototypeConfig, publicPrototypeConfig } from "./config.mjs";

const require = NodeModule.createRequire(import.meta.url);

/** Mounted only by VOICE_COMPARE_ENABLED=1, behind T3's existing voice authentication. */
export function installVoicePrototype(
  app,
  {
    executor,
    incoming,
    startSession = async (options) =>
      (await import("./livekit-host.mjs")).startLivekitPrototype(options),
    getSettings,
    bind,
    getContext,
    bridge,
    baseline,
    onTranscript,
    resolveThread,
    normalizeEnvironmentId = async (id) => id,
    getAutoCallback = () => false,
    recordResult,
  },
) {
  mountAgentSettings(app);
  const calls = new VoiceCallService({ incoming, getAutoCallback, recordResult });
  const { sessions, starting } = calls;
  const settings = livekitPrototypeConfig();
  const staticFile = (path) => (_req, res) =>
    res.sendFile(NodeURL.fileURLToPath(new URL(path, import.meta.url)));
  app.get("/prototype/", staticFile("./index.html"));
  for (const name of ["client.mjs", "metrics.mjs", "style.css"])
    app.get(`/prototype/${name}`, staticFile(`./${name}`));
  app.get("/prototype/livekit-client.js", (_req, res) =>
    res.sendFile(
      require.resolve("livekit-client").replace(/livekit-client[^/]+$/, "livekit-client.umd.js"),
    ),
  );
  const describe = async (req) => {
    const threadId = String(req.query.thread || req.body?.thread || "");
    const ownerId = req.identity.ownerId;
    const environmentId = await normalizeEnvironmentId(String(req.query.environmentId || ""));
    const details = resolveThread
      ? await resolveThread(ownerId, threadId, environmentId)
      : await getSettings(ownerId, threadId);
    return { threadId, ownerId, environmentId, ...details };
  };
  app.get("/prototype/config", (req, res) => {
    void describe(req)
      .then(({ threadId, config }) =>
        res.json({ threadId, ...publicPrototypeConfig(settings, config, baseline()) }),
      )
      .catch(() => res.status(400).json({ error: "Select an active T3 thread." }));
  });
  app.post(["/livekit/session", "/prototype/session"], (req, res) => {
    void (async () => {
      if (settings.missing.length)
        return res.status(503).json({ error: `Brak konfiguracji: ${settings.missing.join(", ")}` });
      const resolved = await describe(req);
      const { threadId, ownerId, environmentId } = resolved;
      const key = voiceCallKey({ ownerId, environmentId, threadId });
      if (
        [...starting].some((k) => JSON.parse(k)[0] === ownerId) ||
        [...sessions.values()].some((s) => s.ownerId === ownerId)
      )
        return res
          .status(409)
          .json({ error: "End the existing LiveKit call before starting another." });
      const callbackId = req.body?.callbackId;
      let callback;
      if (callbackId !== undefined) {
        callback = incoming?.get(ownerId, callbackId);
        if (!callback || callback.environmentId !== environmentId || callback.threadId !== threadId)
          return res.status(404).json({ error: "Callback not found in this thread." });
        if (callback.status !== "pending")
          return res.status(409).json({ error: "This call is no longer ringing." });
        incoming.transition(ownerId, callbackId, "connecting");
      }
      starting.add(key);
      try {
        const binding = resolved.binding ?? (await bind(ownerId, threadId));
        let handle;
        const state = { connected: false };
        handle = await startSession({
          config: settings.config,
          callbackReason: callback
            ? { reason: callback.reason, context: callback.context }
            : undefined,
          executor: {
            runSelectedSession: (...args) =>
              calls.runDelegatedTask(
                { ownerId, environmentId, threadId, voiceSessionId: binding.voiceSessionId },
                () => (resolved.executor ?? executor).runSelectedSession(...args),
                handle?.id,
              ),
          },
          onConnectionChange: (connected) => {
            state.connected = connected;
          },
          onTranscript: (entry) => onTranscript?.(binding, entry),
          binding,
          context: getContext(ownerId, binding.voiceSessionId),
          bridge: bridge(),
          onClose: () => {
            if (handle) sessions.delete(handle.id);
            if (callback) incoming.finish(ownerId, callback.id, "ended");
          },
        });
        if (res.destroyed) {
          await handle.close();
          return;
        }
        if (callback) incoming.finish(ownerId, callback.id, "accepted");
        sessions.set(handle.id, {
          ...handle,
          key,
          ownerId,
          environmentId,
          get connected() {
            return state.connected;
          },
        });
        const { close: _close, notify: _notify, ...connection } = handle;
        res.json(connection);
      } catch (error) {
        if (callback) incoming.finish(ownerId, callback.id, "failed");
        throw error;
      } finally {
        starting.delete(key);
      }
    })().catch((error) => {
      console.error("[voice-prototype] LiveKit startup failed:", error.message);
      if (!res.headersSent)
        res
          .status(502)
          .json({ error: "LiveKit could not start. Check the media server and voice bridge log." });
    });
  });
  app.get("/livekit/push-config", (_req, res) => {
    if (!incoming?.send?.config) return res.status(503).end();
    res.json(incoming.send.config);
  });
  app.delete("/livekit/device", (req, res) => {
    incoming?.unregister(req.identity.ownerId, String(req.query.deviceId || ""));
    res.status(204).end();
  });
  app.post("/livekit/device", (req, res) => {
    if (!incoming) return res.status(503).end();
    try {
      incoming.register(req.identity.ownerId, req.body ?? {});
      res.status(204).end();
    } catch {
      res.status(400).json({ error: "Invalid callback device." });
    }
  });
  app.get("/livekit/incoming/:id", (req, res) => {
    const call = incoming?.get(req.identity.ownerId, req.params.id);
    if (!call) return res.status(404).end();
    const { ownerId: _owner, ...details } = call;
    res.json(details);
  });
  app.delete("/livekit/incoming/:id", (req, res) => {
    try {
      incoming?.transition(req.identity.ownerId, req.params.id, "declined");
      res.status(204).end();
    } catch {
      res.status(409).end();
    }
  });
  app.post("/livekit/call-user", (req, res) => {
    const { reason, context = "" } = req.body ?? {};
    if (
      typeof reason !== "string" ||
      !reason.trim() ||
      reason.length > 2000 ||
      typeof context !== "string" ||
      context.length > 8000
    )
      return res.status(400).json({ error: "A bounded reason and context are required." });
    void describe(req)
      .then((target) => calls.request(target, reason.trim(), context))
      .then((result) => res.json(result))
      .catch(() =>
        res
          .status(502)
          .json({ error: "Could not reach the voice agent. No delivery was confirmed." }),
      );
  });
  app.delete(["/livekit/session/:id", "/prototype/session/:id"], (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session || session.ownerId !== req.identity.ownerId) return res.status(404).end();
    void session
      .close()
      .then(() => res.status(204).end())
      .catch(() => res.status(502).end());
  });
  return Object.assign(() => calls.close(), {
    closeTarget: (ownerId, environmentId) => calls.closeTarget(ownerId, environmentId),
  });
}
