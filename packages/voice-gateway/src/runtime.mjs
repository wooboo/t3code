import { IncomingCalls } from "../prototype/incoming-calls.mjs";
import { createFcmPush } from "../prototype/fcm-push.mjs";
import { createCallPush } from "../prototype/call-push.mjs";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { VoiceTargets } from "./voice-targets.mjs";
import { T3VoiceExecutor } from "./t3-executor.mjs";
import { browserIsAuthorized } from "./browser-auth.mjs";
import { VoiceSettingsStore, buildVoiceContext } from "./voice-settings.mjs";
import { installLlmBridge } from "./llm-bridge.mjs";
import { persistentConversationSync } from "./voice-history.mjs";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

/** Runs inside a worker: gateway configuration never mutates the T3 server's environment. */
export async function createT3VoiceGateway({
  dataDirectory,
  templateDirectory,
  origin,
  token,
  configFile,
  port = 0,
  publicBasePath = "/voice/",
  publicOrigin,
}) {
  if (configFile) {
    for (const [key, value] of Object.entries(
      NodeUtil.parseEnv(NodeFS.readFileSync(configFile, "utf8")),
    ))
      if (process.env[key] === undefined) process.env[key] = value;
  }
  NodeFS.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  process.env.QWAUDIO_CONFIG_DIR = dataDirectory;
  process.env.QWAUDIO_DATA_DIR = dataDirectory;
  process.env.QWEN_AUDIO_AGENT_RUNTIME_ROOT = dataDirectory;
  process.env.QWEN_AUDIO_AGENT_FRONTEND_PROMPT_DIR = templateDirectory;
  process.env.AGENT_PROTOCOL = "none";
  process.env.QWEN_AUDIO_AGENT_IDENTITY_MODE = "personal";
  process.env.QWEN_AUDIO_AGENT_ASSISTANT_PROFILE_PATH ||= NodeFS.existsSync(
    NodePath.join(dataDirectory, "ASSISTANT.md"),
  )
    ? NodePath.join(dataDirectory, "ASSISTANT.md")
    : NodePath.join(templateDirectory, "ASSISTANT.md");
  process.env.PORT = String(port);
  process.env.HOST = "127.0.0.1";
  process.env.QWEN_AUDIO_REALTIME_PROVIDER ||= "speech-to-speech";
  if (!/^\/(?:[a-z0-9-]+\/)*$/.test(publicBasePath))
    throw new Error("Invalid voice public base path");
  if (publicOrigin)
    process.env.QWEN_AUDIO_AGENT_ALLOWED_ORIGINS = [
      process.env.QWEN_AUDIO_AGENT_ALLOWED_ORIGINS,
      publicOrigin,
    ]
      .filter(Boolean)
      .join(",");
  const { createGatewayApplication } = await import("../server/src/app/gateway-application.mjs");
  const { Coordinator } = await import("../server/src/agent/coordinator.mjs");
  const { voiceContexts } = await import("../server/src/agent/voice-contexts.mjs");
  const { ConversationSync } = await import("../server/src/conversation/conversation-sync.mjs");
  const executor = new T3VoiceExecutor({ origin, token });
  const targets = new VoiceTargets(
    NodePath.join(dataDirectory, "execution-targets.json"),
    executor,
  );
  const conversationSync = persistentConversationSync(
    ConversationSync,
    NodePath.join(dataDirectory, "history"),
  );
  const settingsStore = new VoiceSettingsStore(NodePath.join(dataDirectory, "settings"));
  const sessionContexts = new Map();
  const bridgeTokenFile = NodePath.join(dataDirectory, "bridge-token");
  if (!NodeFS.existsSync(bridgeTokenFile))
    NodeFS.writeFileSync(bridgeTokenFile, NodeCrypto.randomBytes(32).toString("hex"), {
      mode: 0o600,
    });
  const bridgeSecret = NodeFS.readFileSync(bridgeTokenFile, "utf8").trim();
  async function getSettings(ownerId, threadId, patch, environmentId) {
    const target = await targets.resolve(ownerId, environmentId);
    const remote = target !== executor;
    const scopedId = remote ? `${environmentId}:${threadId}` : threadId;
    const native = (await target.listNativeSessions()).find((s) => s.sessionId === threadId);
    if (!native?.cwd) throw Error("Nie znaleziono aktywnego wątku T3");
    const projection = await target.threadProjection(threadId);
    const thread = { ...projection.thread, messages: projection.messages };
    const config = patch
      ? settingsStore.update(
          ownerId,
          remote ? `${environmentId}:${native.cwd}` : native.cwd,
          scopedId,
          patch,
        )
      : settingsStore.get(
          ownerId,
          remote ? `${environmentId}:${native.cwd}` : native.cwd,
          scopedId,
        );
    const context = buildVoiceContext({
      workspace: native.cwd,
      readWorkspace: !remote,
      thread,
      config,
      globalSkillRoots: [NodePath.join(NodeOS.homedir(), ".agents/skills")],
    });
    const binding = voiceContexts.bind(ownerId, { ...native, sessionId: scopedId });
    // Carry the durable conversation ID through the speech service's model field.
    const directSessionModel = (model) =>
      "direct-session:" +
      Buffer.from(
        JSON.stringify({
          model: model.replace(/^direct:/, ""),
          sessionId: binding.voiceSessionId,
        }),
      ).toString("base64url");
    sessionContexts.set(`${ownerId}:${binding.voiceSessionId}`, {
      t3Instructions: context.effectiveInstructions,
      t3Model: config.modelSelection
        ? "t3:" + Buffer.from(JSON.stringify(config.modelSelection)).toString("base64url")
        : directSessionModel(process.env.T3_VOICE_LLM_MODEL || "gpt-5.6-luna"),
    });
    let catalog;
    try {
      catalog = await executor.request("/api/voice/catalogue");
    } catch {
      catalog = { providers: [], capabilities: [], unavailable: true };
    }
    return { config, catalog, context: { ...context, terms: config.terms }, binding };
  }
  async function resolveVoiceThread(ownerId, threadId, environmentId) {
    const target = await targets.resolve(ownerId, environmentId);
    const details = await getSettings(ownerId, threadId, undefined, environmentId);
    const handoff = [details.config.instructions.project, details.config.instructions.thread]
      .filter(Boolean)
      .join("\n\n");
    return {
      ...details,
      executor:
        target === executor
          ? executor
          : {
              runSelectedSession: (binding, input, options) =>
                target.runSelectedSession(
                  { ...binding, agentSessionId: threadId },
                  handoff
                    ? {
                        ...input,
                        objective: `${input.objective}\n\n<voice_handoff_context>\n${handoff}\n</voice_handoff_context>`,
                      }
                    : input,
                  options,
                ),
            },
    };
  }
  executor.prepareObjective = async (ownerId, threadId, objective) => {
    const { config, context } = await getSettings(ownerId, threadId);
    const instructions = [
      config.instructions.project,
      config.instructions.thread,
      context.loadedSkills.length
        ? `Skills explicitly selected by the user for this thread (load when applicable):\n${context.loadedSkills.map((s) => `${s.name}: ${s.path}`).join("\n")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    return instructions
      ? `${objective}\n\n<voice_handoff_context>\n${instructions}\n</voice_handoff_context>`
      : objective;
  };
  const prototype =
    process.env.VOICE_COMPARE_ENABLED === "1" ? await import("../prototype/routes.mjs") : undefined;
  let closePrototype;
  let gatewayOrigin;
  const gateway = createGatewayApplication({
    agent: executor,
    conversationSync,
    coordinator: new Coordinator({ client: executor }),
    autoStart: false,
    voiceSessionContext: ({ ownerId, sessionId }) =>
      sessionContexts.get(`${ownerId}:${sessionId}`) || {},
    configureRoutes: ({ app }) => {
      app.get("/execution-targets", (req, res) =>
        res.json({ targets: targets.list(req.identity.ownerId) }),
      );
      app.post("/execution-targets", (req, res) => {
        void targets
          .pair(req.identity.ownerId, req.body.pairingUrl)
          .then((entries) => res.json({ targets: entries }))
          .catch((error) => res.status(400).json({ error: error.message }));
      });
      app.delete("/execution-targets/:environmentId", (req, res) => {
        void (async () => {
          await closePrototype?.closeTarget(req.identity.ownerId, req.params.environmentId);
          targets.remove(req.identity.ownerId, req.params.environmentId);
          res.status(204).end();
        })().catch(() => res.status(500).end());
      });
      app.get("/execution-targets/:environmentId/threads", (req, res) => {
        void targets
          .resolve(req.identity.ownerId, req.params.environmentId)
          .then((target) => target.listNativeSessions())
          .then((threads) => res.json({ threads }))
          .catch((error) => res.status(400).json({ error: error.message }));
      });
      if (prototype)
        closePrototype = prototype.installVoicePrototype(app, {
          executor,
          resolveThread: resolveVoiceThread,
          incoming: new IncomingCalls(NodePath.join(dataDirectory, "incoming-calls.json"), {
            send: process.env.T3CODE_VOICE_FCM_CREDENTIALS
              ? createFcmPush(process.env.T3CODE_VOICE_FCM_CREDENTIALS)
              : createCallPush(NodePath.join(dataDirectory, "push-vapid.json")),
          }),
          normalizeEnvironmentId: async (id) => id || targets.localId(),
          getSettings,
          getAutoCallback: (ownerId) => settingsStore.get(ownerId, "", "").autoCallback,
          recordResult: (target, result, id) =>
            conversationSync.record({
              ownerId: target.ownerId,
              sessionId: target.voiceSessionId,
              id,
              role: "assistant",
              content: result.content,
              source: "agent-result",
              taskId: id,
            }),
          onTranscript: (binding, entry) =>
            conversationSync.record({
              ownerId: binding.ownerId,
              sessionId: binding.voiceSessionId,
              id: entry.id,
              role: entry.role,
              content: entry.content,
              source: "voice",
            }),
          bind: async (ownerId, threadId) => {
            const native = (await executor.listNativeSessions()).find(
              (s) => s.sessionId === threadId,
            );
            if (!native) throw Error("Wątek nie istnieje");
            return voiceContexts.bind(ownerId, native);
          },
          getContext: (ownerId, sessionId) => sessionContexts.get(`${ownerId}:${sessionId}`),
          bridge: () => ({ origin: gatewayOrigin, secret: bridgeSecret }),
          baseline: () => ({
            transport: "PCM/base64 WebSocket",
            provider: process.env.QWEN_AUDIO_REALTIME_PROVIDER,
            models:
              process.env.VOICE_COMPARE_BASELINE_MODELS ||
              "Konfiguracja zewnętrznego serwera mowy — niezweryfikowana",
            history: "existing gateway conversation",
          }),
        });
      app.get("/t3-history", (req, res) => {
        void getSettings(
          req.identity.ownerId,
          String(req.query.thread || ""),
          undefined,
          String(req.query.environmentId || ""),
        )
          .then(({ binding }) => {
            res.json({
              messages: conversationSync
                .list({ ownerId: req.identity.ownerId, sessionId: binding.voiceSessionId })
                .map((m) => ({
                  id: m.id.replace(/^voice:/, ""),
                  role: m.role,
                  content: m.raw ?? m.content,
                })),
            });
          })
          .catch(() => res.status(503).end());
      });
      installLlmBridge(app, {
        executor,
        secret: bridgeSecret,
        directOrigin: process.env.T3_VOICE_LLM_URL,
        directApiType: process.env.T3_VOICE_LLM_API_TYPE || "responses",
        directKey: () => {
          if (process.env.T3_VOICE_LLM_URL) return process.env.T3_VOICE_LLM_KEY || "local";
          const auth = JSON.parse(
            NodeFS.readFileSync(
              NodePath.join(NodeOS.homedir(), ".local/share/opencode/auth.json"),
              "utf8",
            ),
          );
          return auth["opencode-go"]?.key || "";
        },
      });
      for (const method of ["get", "patch"])
        app[method]("/t3-global-settings", (req, res) => {
          void (async () => {
            const owner = req.identity.ownerId;
            const patch = req.body;
            if (
              method === "patch" &&
              (patch.enabledSkills !== undefined ||
                patch.instructions?.project !== undefined ||
                patch.instructions?.thread !== undefined)
            )
              throw Error("Tutaj można zmienić tylko ustawienia globalne");
            const config =
              method === "patch"
                ? settingsStore.update(owner, "", "", patch)
                : settingsStore.get(owner, "", "");
            let catalog;
            try {
              catalog = await executor.request("/api/voice/catalogue");
            } catch {
              catalog = { providers: [], capabilities: [], unavailable: true };
            }
            res.json({
              config,
              catalog,
              context: {
                skills: [],
                agents: [],
                loadedSkills: [],
                omittedSkills: [],
                historySummary: "",
                effectiveInstructions: config.instructions.global,
              },
            });
          })().catch((error) => res.status(400).json({ error: error.message }));
        });
      for (const method of ["get", "patch"])
        app[method]("/t3-settings", (req, res) => {
          void getSettings(
            req.identity.ownerId,
            String(req.query.thread || ""),
            method === "patch" ? req.body : undefined,
            String(req.query.environmentId || ""),
          )
            .then((data) => res.json(data))
            .catch((error) => res.status(400).json({ error: error.message }));
        });
      app.get("/t3-authorize", (req, res) => {
        void browserIsAuthorized(req.headers, executor.origin).then((allowed) => {
          res.status(allowed ? 204 : 401).end();
        });
      });
      app.get("/t3-connect", (req, res, next) => {
        void (async () => {
          try {
            const thread = (await executor.listNativeSessions()).find(
              (s) => s.sessionId === req.query.thread,
            );
            if (!thread)
              return res.status(404).send("Wątek nie istnieje w tej testowej instancji T3 Code.");
            const context = voiceContexts.bind(req.identity.ownerId, thread);
            await getSettings(req.identity.ownerId, thread.sessionId);
            if (req.query.format === "json") {
              return res.json({ sessionId: context.voiceSessionId });
            }
            res.redirect(
              `${publicBasePath}?session=${encodeURIComponent(context.voiceSessionId)}&embed=t3`,
            );
          } catch {
            res.status(503).send("Nie można połączyć się z T3 Code.");
          }
        })().catch(next);
      });
    },
  });
  const server = gateway.start({ port });
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  gatewayOrigin = `http://127.0.0.1:${server.address().port}`;
  return {
    ...gateway,
    origin: gatewayOrigin,
    close: async () => {
      await closePrototype?.();
      await gateway.close();
    },
  };
}
