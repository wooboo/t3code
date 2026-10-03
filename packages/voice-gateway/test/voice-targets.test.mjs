import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { VoiceTargets } from "../src/voice-targets.mjs";
import { buildVoiceContext } from "../src/voice-settings.mjs";

NodeTest.test(
  "paired execution targets survive restart, hide credentials, and isolate owners",
  async (t) => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "voice-targets-"));
    t.after(() => NodeFS.rmSync(dir, { recursive: true, force: true }));
    const local = { origin: "http://localhost:1" };
    const calls = [];
    const fetcher = async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/.well-known/t3/environment"))
        return Response.json({
          environmentId: url.startsWith(local.origin) ? "local" : "remote",
          label: "Remote",
          orchestrationProtocolVersion: 2,
        });
      if (url.endsWith("/oauth/token"))
        return Response.json({
          token_type: "Bearer",
          access_token: "private-token",
          expires_in: 3600,
        });
      NodeAssert.equal(init.headers.Authorization, "Bearer private-token");
      return Response.json({
        projects: [{ id: "project", workspaceRoot: "/remote/project" }],
        threads: [{ id: "same-thread", title: "Remote thread", projectId: "project" }],
      });
    };
    const file = NodePath.join(dir, "targets.json");
    const targets = new VoiceTargets(file, local, fetcher);
    const publicTargets = await targets.pair("alice", "http://remote.test:3773/pair#token=one-use");
    NodeAssert.equal(publicTargets[0].environmentId, "remote");
    NodeAssert.ok(!JSON.stringify(publicTargets).includes("private-token"));
    NodeAssert.deepEqual(targets.list("bob"), []);
    await NodeAssert.rejects(targets.resolve("bob", "remote"), /Pair this execution/);
    NodeAssert.equal(await targets.resolve("alice", "local"), local);
    const restored = new VoiceTargets(file, local, fetcher);
    const executor = await restored.resolve("alice", "remote");
    NodeAssert.equal((await executor.listNativeSessions())[0].title, "Remote thread");
    NodeAssert.equal(NodeFS.statSync(file).mode & 0o777, 0o600);
    restored.remove("alice", "remote");
    await NodeAssert.rejects(restored.resolve("alice", "remote"), /Pair this execution/);
    NodeAssert.equal(calls.filter((c) => c.url.endsWith("/oauth/token")).length, 1);
  },
);

NodeTest.test("remote thread context never reads a matching path on the Voice host", (t) => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "voice-foreign-"));
  t.after(() => NodeFS.rmSync(dir, { recursive: true, force: true }));
  NodeFS.writeFileSync(NodePath.join(dir, "AGENTS.md"), "HOST-ONLY-INSTRUCTIONS");
  const context = buildVoiceContext({
    workspace: dir,
    readWorkspace: false,
    thread: { messages: [{ role: "user", text: "Remote history" }] },
    config: {
      instructions: { global: "Voice instructions", project: "", thread: "" },
      enabledSkills: [],
    },
  });
  NodeAssert.deepEqual(context.agents, []);
  NodeAssert.ok(!context.effectiveInstructions.includes("HOST-ONLY-INSTRUCTIONS"));
  NodeAssert.ok(context.effectiveInstructions.includes("Remote history"));
});

NodeTest.test(
  "remote execution preserves the target's model and permissions and never retries uncertain dispatch",
  async (t) => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "voice-route-"));
    t.after(() => NodeFS.rmSync(dir, { recursive: true, force: true }));
    const sent = [];
    let messageId;
    let loseAcknowledgement = false;
    const fetcher = async (url, init) => {
      if (url.endsWith("/.well-known/t3/environment"))
        return Response.json({ environmentId: "local" });
      NodeAssert.ok(url.startsWith("http://remote.test"));
      return Response.json({
        projection: {
          thread: {
            modelSelection: { instanceId: "claude", model: "target-model" },
            runtimeMode: "approval-required",
            interactionMode: "default",
          },
          runs: messageId
            ? [{ id: "remote-run", userMessageId: messageId, status: "completed" }]
            : [],
          messages: messageId
            ? [
                { id: messageId, role: "user" },
                {
                  id: "answer",
                  role: "assistant",
                  text: "Remote result",
                  runId: "remote-run",
                  streaming: false,
                },
              ]
            : [],
        },
      });
    };
    const targets = new VoiceTargets(
      NodePath.join(dir, "targets.json"),
      { origin: "http://localhost:1" },
      fetcher,
    );
    targets.add("alice", {
      environmentId: "remote",
      label: "Remote",
      origin: "http://remote.test",
      token: "secret",
      expiresAt: Date.now() + 60000,
    });
    const executor = await targets.resolve("alice", "remote");
    executor.dispatchCommand = async (command) => {
      sent.push(command);
      messageId = command.messageId;
      if (loseAcknowledgement) throw Error("Connection lost after dispatch");
      return { sequence: sent.length };
    };
    const result = await executor.runSelectedSession(
      { ownerId: "alice", agentSessionId: "same-thread" },
      { objective: "Do the task" },
      { ownerId: "alice" },
    );
    NodeAssert.equal(result.content, "Remote result");
    NodeAssert.equal(sent[0].threadId, "same-thread");
    NodeAssert.deepEqual(sent[0].modelSelection, { instanceId: "claude", model: "target-model" });
    NodeAssert.ok(!("runtimeMode" in sent[0]), "v2 inherits the target thread’s permissions");
    loseAcknowledgement = true;
    await NodeAssert.rejects(
      executor.runSelectedSession(
        { ownerId: "alice", agentSessionId: "same-thread" },
        { objective: "Another task" },
        { ownerId: "alice" },
      ),
      /Connection lost/,
    );
    NodeAssert.equal(sent.length, 2);
  },
);

NodeTest.test(
  "rejects protocol-v1 targets before consuming their pairing credential",
  async (t) => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "voice-protocol-"));
    t.after(() => NodeFS.rmSync(dir, { recursive: true, force: true }));
    const targets = new VoiceTargets(
      NodePath.join(dir, "targets.json"),
      { origin: "http://local.test" },
      async (url) => {
        NodeAssert.ok(
          url.endsWith("/.well-known/t3/environment"),
          "must not consume the pairing token",
        );
        return Response.json({ environmentId: "remote", orchestrationProtocolVersion: 1 });
      },
    );
    await NodeAssert.rejects(
      targets.pair("owner", "http://remote.test/pair#token=unused"),
      /protocol-v2/,
    );
  },
);
