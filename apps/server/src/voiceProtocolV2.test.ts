import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { OrchestrationV2Command } from "@t3tools/contracts";
import { T3VoiceExecutor } from "../../../packages/voice-gateway/src/t3-executor.mjs";

it("spoken follow-ups satisfy the v2 command contract and retain user provenance", async () => {
  const executor = new T3VoiceExecutor({
    origin: "http://unused.test",
    token: "test",
    fetchImpl: async () =>
      Response.json({
        projection: {
          thread: { modelSelection: { instanceId: "codex", model: "test" } },
          runs: [{ id: "existing-run", status: "running" }],
          messages: [],
        },
      }),
  });
  let admitted = false;
  executor.dispatchCommand = async (payload) => {
    const command = Schema.decodeUnknownSync(OrchestrationV2Command)(payload);
    expect(command.type).toBe("message.dispatch");
    if (command.type !== "message.dispatch") throw Error("Expected a spoken message");
    expect(command.createdBy).toBe("user");
    expect(command.deliveryIntent).toBe("auto");
    expect(command.text).toBe("Use the existing API");
    admitted = true;
    return { sequence: 1 };
  };
  await executor.runSelectedSession(
    { ownerId: "owner", agentSessionId: "thread" },
    { objective: "Use the existing API" },
    { ownerId: "owner" },
  );
  expect(admitted).toBe(true);
});
