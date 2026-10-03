import { test } from "node:test";
import assert from "node:assert/strict";
import { T3VoiceExecutor } from "../src/t3-executor.mjs";
import { TaskManager } from "../server/src/task/task-manager.mjs";
import { ToolCallHandler } from "../server/src/voice/tools/tool-call-handler.mjs";

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

test(
  "a spoken follow-up reaches the active thread before the original voice work finishes",
  { timeout: 3000 },
  async () => {
    const waiting = deferred();
    const finish = deferred();
    const commands = [];
    const executor = new T3VoiceExecutor({
      origin: "http://localhost:1",
      token: "test",
      wait: async () => {
        waiting.resolve();
        await finish.promise;
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
              ? [{ id: "original-run", userMessageId: commands[0].messageId, status: "running" }]
              : [],
            messages: commands.map((c) => ({
              id: c.messageId,
              role: "user",
              text: c.text,
            })),
          },
        });
      },
    });
    executor.dispatchCommand = async (command) => {
      commands.push(command);
      return { sequence: commands.length };
    };
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
          executor.runSelectedSession(
            { ownerId: "owner", agentSessionId: "thread" },
            input,
            options,
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
      const result = await manager.wait(next.id);
      assert.equal(result.status, "completed");
      assert.deepEqual(
        commands.map((c) => c.text),
        ["Implement feature", "Use the existing API"],
      );
      assert.ok(commands.every((c) => c.type === "message.dispatch"));
      assert.equal(manager.tasks.get(first.id).status, "running");
    } finally {
      finish.resolve();
      // A later user instruction ends result ownership, not the native agent turn.
      await manager.wait(first.id);
    }
  },
);
