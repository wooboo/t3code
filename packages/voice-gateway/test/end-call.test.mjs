import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeTimersPromises from "node:timers/promises";
import { endCallTool, endVoiceCall } from "../prototype/end-call.mjs";

NodeTest.test(
  "hangup returns before closing its own session and repeated requests close once",
  async () => {
    let closed = 0;
    const tool = endCallTool({ endCall: async () => closed++, onError: NodeAssert.fail });
    NodeAssert.deepEqual(await tool.execute({}), { state: "ending" });
    await tool.execute({});
    NodeAssert.equal(closed, 0);
    await NodeTimersPromises.setImmediate();
    NodeAssert.equal(closed, 1);
  },
);

NodeTest.test(
  "reports asynchronous transport cleanup errors without an unhandled rejection",
  async () => {
    const error = Error("room service unavailable");
    let reported;
    const tool = endCallTool({
      endCall: async () => {
        throw error;
      },
      onError: (e) => {
        reported = e;
      },
    });
    await tool.execute({});
    await NodeTimersPromises.setImmediate();
    NodeAssert.equal(reported, error);
  },
);

for (const failure of [undefined, "publish", "delete"]) {
  NodeTest.test(
    `hangup deletes the room and releases the session (failure: ${failure})`,
    async () => {
      const steps = [];
      const promise = endVoiceCall({
        room: {
          localParticipant: {
            publishData: async (data, options) => {
              NodeAssert.deepEqual(JSON.parse(data), { type: "call.ended" });
              NodeAssert.equal(options.reliable, true);
              steps.push("publish");
              if (failure === "publish") throw Error("disconnected");
            },
          },
        },
        deleteRoom: async () => {
          steps.push("delete");
          if (failure === "delete") throw Error("unavailable");
        },
        close: async () => {
          steps.push("close");
        },
      });
      if (failure === "delete") await NodeAssert.rejects(promise, /unavailable/);
      else await promise;
      NodeAssert.deepEqual(steps, ["publish", "delete", "close"]);
    },
  );
}
