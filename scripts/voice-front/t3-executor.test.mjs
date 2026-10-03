import { test } from "node:test";
import assert from "node:assert/strict";
import { T3VoiceExecutor } from "./t3-executor.mjs";

const context = { ownerId: "owner", agentSessionId: "thread" };
const thread = {
  modelSelection: { instanceId: "codex", model: "existing-model" },
  runtimeMode: "approval-required",
  interactionMode: "default",
};
function executorFor(projection, dispatch, wait = async () => {}) {
  const executor = new T3VoiceExecutor({
    origin: "http://localhost:1",
    token: "test",
    wait,
    fetchImpl: async (_url, options) => {
      assert.equal(options.headers.Authorization, "Bearer test");
      assert.equal(options.headers["x-t3-orchestration-protocol"], "2");
      return Response.json({ projection: projection() });
    },
  });
  executor.dispatchCommand = dispatch;
  return executor;
}

test("dispatches a v2 message and returns only the submitted run's result", async () => {
  let command;
  const executor = executorFor(
    () => ({
      thread,
      runs: command ? [{ id: "run", userMessageId: command.messageId, status: "completed" }] : [],
      messages: command
        ? [
            { id: command.messageId, role: "user" },
            {
              id: "old-answer",
              role: "assistant",
              runId: "other",
              text: "Unrelated",
              streaming: false,
            },
            { id: "answer", role: "assistant", runId: "run", text: "Result", streaming: false },
          ]
        : [],
    }),
    async (value) => {
      command = value;
      return { sequence: 1 };
    },
  );
  assert.equal(
    (await executor.runSelectedSession(context, { objective: "Continue" }, { ownerId: "owner" }))
      .content,
    "Result",
  );
  assert.equal(command.type, "message.dispatch");
  assert.equal(command.threadId, "thread");
  assert.deepEqual(command.modelSelection, thread.modelSelection);
  assert.deepEqual(command.dispatchMode, { type: "start_immediately" });
  assert.equal(command.deliveryIntent, "auto");
  assert.equal(executor.locks.size, 0);
});

for (const status of ["preparing", "queued", "starting", "running", "waiting"]) {
  test(`acknowledges a v2 follow-up during ${status} without owning the existing run`, async () => {
    const commands = [];
    const executor = executorFor(
      () => ({ thread, messages: [], runs: [{ id: "existing", status }] }),
      async (command) => {
        commands.push(command);
      },
      () => assert.fail("Follow-ups must not wait for another caller's result"),
    );
    const result = await executor.runSelectedSession(
      context,
      { objective: "Use the existing API" },
      { ownerId: "owner" },
    );
    assert.equal(commands.length, 1);
    assert.equal(commands[0].text, "Use the existing API");
    assert.match(result.content, /Przekazano/);
    assert.equal(executor.locks.size, 0);
  });
}

test("does not acknowledge a rejected voice dispatch", async () => {
  const executor = executorFor(
    () => ({ thread, runs: [{ id: "existing", status: "running" }], messages: [] }),
    async () => {
      throw Error("Rejected");
    },
  );
  await assert.rejects(
    executor.runSelectedSession(context, { objective: "Follow up" }, { ownerId: "owner" }),
    /Rejected/,
  );
  assert.equal(executor.locks.size, 0);
});

test("interrupts only the run owned by this voice request", async () => {
  const abort = new AbortController();
  const commands = [];
  const executor = executorFor(
    () => ({
      thread,
      runs: commands.length
        ? [{ id: "owned", userMessageId: commands[0].messageId, status: "running" }]
        : [],
      messages: commands.length ? [{ id: commands[0].messageId, role: "user" }] : [],
    }),
    async (command) => {
      commands.push(command);
    },
    async () => {
      abort.abort(Error("Hang up"));
      throw abort.signal.reason;
    },
  );
  await assert.rejects(
    executor.runSelectedSession(
      context,
      { objective: "Work" },
      { ownerId: "owner", signal: abort.signal },
    ),
    /Hang up/,
  );
  assert.deepEqual(
    commands.map((command) => command.type),
    ["message.dispatch", "run.interrupt"],
  );
  assert.equal(commands[1].runId, "owned");
});

test("rejects a context owned by another caller before making requests", async () => {
  const executor = executorFor(
    () => assert.fail("No reads expected"),
    () => assert.fail("No command expected"),
  );
  await assert.rejects(executor.runSelectedSession(context, {}, { ownerId: "other" }), /innego/);
});
