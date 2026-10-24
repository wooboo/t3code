import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { VoiceCallService } from "../src/voice-call-service.mjs";
import { VoiceSettingsStore, validateVoicePatch } from "../src/voice-settings.mjs";
import { IncomingCalls } from "../prototype/incoming-calls.mjs";
import { voiceCallKey } from "../prototype/call-user.mjs";
import { pushDevice } from "./push-fixtures.mjs";
import { persistentConversationSync } from "../src/voice-history.mjs";
import { ConversationSync } from "../server/src/conversation/conversation-sync.mjs";

const target = {
  ownerId: "owner",
  environmentId: "remote",
  threadId: "thread",
  voiceSessionId: "voice-remote-thread",
};
const result = { content: "Wdrożono zmianę. Testy przeszły." };
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(t) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-auto-callback-"));
  t.after(() => NodeFS.rmSync(dir, { recursive: true, force: true }));
  const settings = new VoiceSettingsStore(NodePath.join(dir, "settings"));
  const pushes = [];
  const notifications = [];
  const historyDirectory = NodePath.join(dir, "history");
  const history = persistentConversationSync(ConversationSync, historyDirectory);
  const incoming = new IncomingCalls(NodePath.join(dir, "incoming.json"), {
    send: async (_device, payload, options) => {
      (options?.kind === "voice_result" ? notifications : pushes).push(payload);
    },
  });
  incoming.register(target.ownerId, pushDevice());
  const service = new VoiceCallService({
    incoming,
    getAutoCallback: (ownerId) => settings.get(ownerId, "", "").autoCallback,
    recordResult: (scope, result, id) =>
      history.record({
        ownerId: scope.ownerId,
        sessionId: scope.voiceSessionId,
        id,
        role: "assistant",
        source: "agent-result",
        content: result.content,
        taskId: id,
      }),
  });
  const enable = (enabled = true) =>
    settings.update(target.ownerId, "", "", { autoCallback: enabled });
  const notices = [];
  const session = {
    id: "original",
    key: voiceCallKey(target),
    ownerId: target.ownerId,
    environmentId: target.environmentId,
    connected: true,
    notify: async (message) => notices.push(message),
    close: async () => service.sessions.delete(session.id),
  };
  service.sessions.set(session.id, session);
  return {
    service,
    settings,
    incoming,
    pushes,
    notifications,
    history,
    historyDirectory,
    enable,
    notices,
    session,
  };
}

NodeTest.test(
  "voice results are persisted and notified with callbacks off, missed, declined or unavailable",
  async (t) => {
    for (const outcome of ["off", "missed", "declined", "busy"]) {
      const f = fixture(t);
      if (outcome !== "off") f.enable();
      await f.session.close();
      if (outcome === "busy")
        f.service.sessions.set("other", {
          ...f.session,
          id: "other",
          key: voiceCallKey({ ...target, threadId: "other" }),
        });
      await f.service.runDelegatedTask(target, async () => result);
      if (outcome === "missed" || outcome === "declined") {
        const { callId } = f.pushes[0];
        if (outcome === "missed") {
          f.incoming.now = () => f.incoming.state.calls[callId].expiresAt + 1;
          NodeAssert.equal(f.incoming.get(target.ownerId, callId).status, "missed");
        } else f.incoming.transition(target.ownerId, callId, "declined");
      }
      const restored = persistentConversationSync(ConversationSync, f.historyDirectory);
      const messages = restored.list({ ownerId: target.ownerId, sessionId: target.voiceSessionId });
      NodeAssert.equal(messages.length, 1);
      NodeAssert.equal(messages[0].content, result.content);
      NodeAssert.equal(messages[0].source, "agent-result");
      NodeAssert.equal(f.notifications.length, 1);
      NodeAssert.equal(f.notifications[0].messageId, messages[0].id);
      NodeAssert.equal(f.notifications[0].environmentId, target.environmentId);
      NodeAssert.equal(f.notifications[0].threadId, target.threadId);
      NodeAssert.equal(JSON.stringify(f.notifications).includes(result.content), false);
      NodeAssert.deepEqual(
        restored.list({ ownerId: "other", sessionId: target.voiceSessionId }),
        [],
      );
    }
  },
);

NodeTest.test(
  "voice callback opt-in defaults off, persists per owner, validates booleans and can be disabled",
  (t) => {
    const f = fixture(t);
    NodeAssert.equal(f.settings.get(target.ownerId, "", "").autoCallback, false);
    f.enable();
    const restored = new VoiceSettingsStore(f.settings.directory);
    NodeAssert.equal(
      restored.get(target.ownerId, "/other-project", "other-thread").autoCallback,
      true,
    );
    NodeAssert.equal(restored.get("other-owner", "", "").autoCallback, false);
    f.enable(false);
    NodeAssert.equal(restored.get(target.ownerId, "", "").autoCallback, false);
    for (const autoCallback of ["true", 1, null, {}])
      NodeAssert.throws(() => validateVoicePatch({ autoCallback }));
  },
);

NodeTest.test(
  "delegated work survives hangup and rings the registered phone with the original remote thread's result",
  async (t) => {
    const f = fixture(t);
    f.enable();
    const done = deferred();
    const work = f.service.runDelegatedTask(target, () => done.promise);
    NodeAssert.equal(f.pushes.length, 0);
    await f.session.close();
    done.resolve(result);
    NodeAssert.equal(await work, result);
    NodeAssert.equal(f.pushes.length, 1);
    const call = f.incoming.get(target.ownerId, f.pushes[0].callId);
    NodeAssert.equal(call.environmentId, target.environmentId);
    NodeAssert.equal(call.threadId, target.threadId);
    NodeAssert.equal(call.context, result.content);
    NodeAssert.equal(f.incoming.get("other-owner", call.id), null);
  },
);

NodeTest.test(
  "a connected or reconnected call receives the result without a second ring",
  async (t) => {
    for (const enabled of [false, true]) {
      const f = fixture(t);
      f.enable(enabled);
      const done = deferred();
      const work = f.service.runDelegatedTask(target, () => done.promise);
      f.session.connected = false;
      f.session.connected = true;
      done.resolve(result);
      await work;
      NodeAssert.equal(f.pushes.length, 0);
      NodeAssert.equal(f.notices.length, 1);
      NodeAssert.equal(f.notices[0].context, result.content);
    }
  },
);

NodeTest.test(
  "a result delivered after the original call ended reaches a new call in the same thread",
  async (t) => {
    const f = fixture(t);
    const done = deferred();
    const work = f.service.runDelegatedTask(target, () => done.promise);
    await f.session.close();
    f.service.sessions.set("new-call", { ...f.session, id: "new-call" });
    done.resolve(result);
    await work;
    NodeAssert.equal(f.notices.length, 1);
    NodeAssert.equal(f.pushes.length, 0);
  },
);

NodeTest.test(
  "the original connected voice process receives the result without a duplicate handoff",
  async (t) => {
    const f = fixture(t);
    f.enable();
    NodeAssert.equal(
      await f.service.runDelegatedTask(target, async () => result, f.session.id),
      result,
    );
    NodeAssert.equal(f.notices.length, 0);
    NodeAssert.equal(f.pushes.length, 0);
  },
);

NodeTest.test(
  "disabling callbacks or unpairing while the disconnected room closes prevents ringing",
  async (t) => {
    for (const stop of ["disable", "unpair"]) {
      const f = fixture(t);
      f.enable();
      f.session.connected = false;
      f.session.close = async () => {
        f.service.sessions.delete(f.session.id);
        if (stop === "disable") f.enable(false);
        else await f.service.closeTarget(target.ownerId, target.environmentId);
      };
      await f.service.runDelegatedTask(target, async () => result);
      NodeAssert.equal(f.pushes.length, 0);
    }
  },
);

NodeTest.test("a disconnected room is released before requesting the callback", async (t) => {
  const f = fixture(t);
  f.enable();
  f.session.connected = false;
  await f.service.runDelegatedTask(target, async () => result);
  NodeAssert.equal(f.service.sessions.size, 0);
  NodeAssert.equal(f.pushes.length, 1);
});

NodeTest.test("disabling callbacks while work runs takes effect before completion", async (t) => {
  const f = fixture(t);
  f.enable();
  const done = deferred();
  const work = f.service.runDelegatedTask(target, () => done.promise);
  await f.session.close();
  f.enable(false);
  done.resolve(result);
  await work;
  NodeAssert.equal(f.pushes.length, 0);
});

NodeTest.test("off and nonterminal work never rings a disconnected user", async (t) => {
  for (const state of ["off", "superseded"]) {
    const f = fixture(t);
    if (state !== "off") f.enable();
    await f.session.close();
    await f.service.runDelegatedTask(target, async () => ({
      ...result,
      completed: state !== "superseded",
    }));
    NodeAssert.equal(f.pushes.length, 0);
  }
});

NodeTest.test(
  "another thread or environment's active call is never interrupted or redirected",
  async (t) => {
    for (const other of [
      { ...target, threadId: "other" },
      { ...target, environmentId: "other" },
    ]) {
      const f = fixture(t);
      f.enable();
      f.session.key = voiceCallKey(other);
      await f.service.runDelegatedTask(target, async () => result);
      NodeAssert.equal(f.pushes.length, 0);
      NodeAssert.equal(f.notices.length, 0);
      NodeAssert.equal(f.service.sessions.size, 1);
    }
  },
);

NodeTest.test(
  "shutdown or unpairing suppresses callbacks from work already in flight",
  async (t) => {
    for (const stop of ["shutdown", "unpair"]) {
      const f = fixture(t);
      f.enable();
      const done = deferred();
      const work = f.service.runDelegatedTask(target, () => done.promise);
      if (stop === "shutdown") await f.service.close();
      else await f.service.closeTarget(target.ownerId, target.environmentId);
      done.resolve(result);
      await work;
      NodeAssert.equal(f.pushes.length, 0);
    }
  },
);

NodeTest.test(
  "pending invitations coalesce completions and missing push never changes the coding result",
  async (t) => {
    const f = fixture(t);
    f.enable();
    await f.session.close();
    await f.service.runDelegatedTask(target, async () => result);
    await f.service.runDelegatedTask(target, async () => result);
    NodeAssert.equal(f.pushes.length, 1);
    f.incoming.unregister(target.ownerId, pushDevice().deviceId);
    NodeAssert.equal(await f.service.runDelegatedTask(target, async () => result), result);
    NodeAssert.equal(f.pushes.length, 1);
  },
);

NodeTest.test("reconnection during result push preserves the active session", async (t) => {
  for (const replacement of [false, true]) {
    const f = fixture(t);
    f.enable();
    f.session.connected = false;
    const pushing = deferred();
    const finish = deferred();
    f.incoming.notifyResult = async () => {
      pushing.resolve();
      await finish.promise;
    };
    const work = f.service.runDelegatedTask(target, async () => result, f.session.id);
    await pushing.promise;
    const active = replacement ? { ...f.session, id: "replacement", connected: true } : f.session;
    active.connected = true;
    if (replacement) {
      f.service.sessions.delete(f.session.id);
      f.service.sessions.set(active.id, active);
    }
    finish.resolve();
    await work;
    NodeAssert.equal(f.service.sessions.get(active.id), active);
    NodeAssert.equal(f.pushes.length, 0);
    NodeAssert.equal(f.notices.length, replacement ? 1 : 0);
  }
});

NodeTest.test(
  "execution failure and timeout persist a safe result and notify a disconnected user",
  async (t) => {
    for (const message of ["provider failed: secret", "timeout"]) {
      const f = fixture(t);
      f.enable();
      await f.session.close();
      const error = Error(message);
      await NodeAssert.rejects(
        f.service.runDelegatedTask(target, async () => {
          throw error;
        }),
        (e) => e === error,
      );
      const messages = f.history.list({
        ownerId: target.ownerId,
        sessionId: target.voiceSessionId,
      });
      NodeAssert.equal(messages.length, 1);
      NodeAssert.match(messages[0].content, /błędem|czas/);
      NodeAssert.equal(messages[0].content.includes(message), false);
      NodeAssert.equal(f.notifications.length, 1);
      NodeAssert.equal(f.pushes.length, 1);
    }
  },
);

NodeTest.test(
  "failed history persistence or result push does not block other delivery channels",
  async (t) => {
    for (const channel of ["history", "push"]) {
      const f = fixture(t);
      f.enable();
      await f.session.close();
      if (channel === "history")
        f.service.recordResult = async () => {
          throw Error("disk full");
        };
      else
        f.incoming.notifyResult = async () => {
          throw Error("push unavailable");
        };
      NodeAssert.equal(await f.service.runDelegatedTask(target, async () => result), result);
      NodeAssert.equal(f.pushes.length, 1);
      if (channel === "history") NodeAssert.equal(f.notifications.length, 1);
      else
        NodeAssert.equal(
          f.history.list({ ownerId: target.ownerId, sessionId: target.voiceSessionId }).length,
          1,
        );
    }
  },
);
