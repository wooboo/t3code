import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { T3VoiceExecutor } from "../src/t3-executor.mjs";
import { VoiceCallService } from "../src/voice-call-service.mjs";
import { TaskManager } from "../server/src/task/task-manager.mjs";
import { ToolCallHandler } from "../server/src/voice/tools/tool-call-handler.mjs";

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

NodeTest.test(
  "a spoken follow-up reaches the active thread before the original voice work finishes",
  { timeout: 3000 },
  async () => {
    const waiting = deferred();
    const finish = deferred();
    const commands = [];
    let terminal = false;
    const admitted = deferred();
    const executor = new T3VoiceExecutor({
      origin: "http://localhost:1",
      token: "test",
      wait: async () => {
        waiting.resolve();
        await finish.promise;
        terminal = true;
      },
      fetchImpl: async () => {
        return Response.json({
          projection: {
            thread: {
              modelSelection: { instanceId: "codex", model: "existing" },
              runtimeMode: "full-access",
              interactionMode: "default",
            },
            runs: commands.length
              ? [
                  {
                    id: "original-run",
                    userMessageId: commands[0].messageId,
                    status: terminal ? "completed" : "running",
                  },
                ]
              : [],
            messages: commands.map((c) => ({
              id: c.messageId,
              runId: "original-run",
              role: "user",
              text: c.text,
            })),
          },
        });
      },
    });
    executor.dispatchCommand = async (command) => {
      commands.push(command);
      if (commands.length === 2) admitted.resolve();
      return { sequence: commands.length };
    };
    const recorded = new Map();
    const notifications = [];
    const target = { ownerId: "owner", environmentId: "env", threadId: "thread" };
    const service = new VoiceCallService({
      getAutoCallback: () => false,
      recordResult: (_target, result, id) => recorded.set(id, result),
      incoming: { notifyResult: async (_target, id) => notifications.push(id) },
    });
    const manager = new TaskManager({
      maxConcurrent: 1,
      maxConcurrentPerOwner: 1,
      progressCheckMs: 0,
    });
    const handler = new ToolCallHandler({
      taskManager: manager,
      ownerId: "owner",
      sessionId: "voice",
      coordinator: {
        client: executor,
        run: (input, options) =>
          service.runDelegatedTask(target, () =>
            executor.runSelectedSession(
              { ownerId: "owner", agentSessionId: "thread" },
              input,
              options,
            ),
          ),
      },
    });
    const first = handler.createWork({
      turnId: "spoken-1",
      objective: "Implement feature",
      submissionKey: "1",
    });
    try {
      await waiting.promise;
      const next = handler.createWork({
        turnId: "spoken-2",
        objective: "Use the existing API",
        submissionKey: "2",
      });
      await admitted.promise;
      NodeAssert.deepEqual(
        commands.map((c) => c.text),
        ["Implement feature", "Use the existing API"],
      );
      NodeAssert.ok(commands.every((c) => c.type === "message.dispatch"));
      NodeAssert.equal(manager.tasks.get(first.id).status, "running");
      NodeAssert.equal(manager.tasks.get(next.id).status, "running");
      NodeAssert.equal(recorded.size, 0);
      NodeAssert.equal(notifications.length, 0);
      finish.resolve();
      NodeAssert.equal((await manager.wait(next.id)).status, "completed");
      NodeAssert.equal((await manager.wait(first.id)).status, "completed");
      NodeAssert.equal(recorded.size, 1);
      NodeAssert.ok(notifications.length >= 1);
      NodeAssert.equal(new Set(notifications).size, 1);
    } finally {
      finish.resolve();
      await manager.wait(first.id);
    }
  },
);

NodeTest.test(
  "steered and queued messages observe their own terminal run despite later instructions",
  async () => {
    for (const steered of [true, false]) {
      let dispatched;
      let polls = 0;
      const executor = new T3VoiceExecutor({
        origin: "http://localhost:1",
        token: "test",
        wait: async () => {
          polls++;
        },
        fetchImpl: async () =>
          Response.json({
            projection: {
              thread: { modelSelection: { instanceId: "codex", model: "existing" } },
              messages: dispatched
                ? [
                    {
                      id: dispatched.messageId,
                      runId: steered ? "active" : "queued",
                      role: "user",
                    },
                    { id: "later-instruction", role: "user", runId: "later" },
                    {
                      id: "reply",
                      runId: steered ? "active" : "queued",
                      role: "assistant",
                      text: "Done",
                      streaming: false,
                    },
                  ]
                : [],
              runs: [
                {
                  id: "active",
                  userMessageId: "earlier",
                  status: polls > 0 ? "completed" : "running",
                },
                ...(dispatched && !steered
                  ? [
                      {
                        id: "queued",
                        userMessageId: dispatched.messageId,
                        status: polls > 0 ? "completed" : "pending",
                      },
                    ]
                  : []),
                { id: "later", userMessageId: "later-instruction", status: "running" },
              ],
            },
          }),
      });
      executor.dispatchCommand = async (command) => {
        dispatched = command;
      };
      NodeAssert.deepEqual(
        await executor.runSelectedSession(
          { ownerId: "owner", agentSessionId: "thread" },
          { objective: "follow up" },
          { ownerId: "owner" },
        ),
        { content: "Done", runId: steered ? "active" : "queued" },
      );
      NodeAssert.equal(polls, 1);
    }
  },
);

NodeTest.test(
  "a steered task reports terminal failure and deterministic timeout without interrupting another run",
  async () => {
    for (const status of ["failed", "interrupted", "cancelled", "running"]) {
      let dispatched;
      let now = 0;
      const commands = [];
      const executor = new T3VoiceExecutor({
        origin: "http://localhost:1",
        token: "test",
        now: () => now,
        completionTimeoutMs: 10,
        wait: async () => {
          now += 10;
        },
        fetchImpl: async () =>
          Response.json({
            projection: {
              thread: {},
              messages: dispatched
                ? [{ id: dispatched.messageId, runId: "foreign", role: "user" }]
                : [],
              runs: [{ id: "foreign", userMessageId: "earlier", status }],
            },
          }),
      });
      executor.dispatchCommand = async (command) => {
        dispatched = command;
        commands.push(command);
      };
      await NodeAssert.rejects(
        executor.runSelectedSession(
          { ownerId: "owner", agentSessionId: "thread" },
          { objective: "follow up" },
          { ownerId: "owner" },
        ),
        status === "running" ? /czas/ : new RegExp(status),
      );
      NodeAssert.equal(commands.length, 1);
    }
  },
);
