import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { dispatchT3Command } from "../src/t3-rpc.mjs";

for (const rejected of [false, true]) {
  test(`v2 command RPC authenticates, negotiates and ${rejected ? "rejects failure" : "waits for commit acknowledgement"}`, async () => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await once(server, "listening");
    const command = {
      type: "run.interrupt",
      commandId: "command",
      threadId: "thread",
      runId: "owned",
    };
    server.on("connection", (socket, request) => {
      assert.equal(request.url, "/ws?orchestrationProtocol=2");
      assert.equal(request.headers.authorization, "Bearer credential");
      socket.on("message", (data) => {
        const rpc = JSON.parse(data.toString());
        assert.equal(rpc.tag, "orchestration.dispatchCommand");
        assert.deepEqual(rpc.payload, command);
        socket.send(
          JSON.stringify({
            _tag: "Exit",
            requestId: rpc.id,
            exit: rejected
              ? { _tag: "Failure", cause: [] }
              : { _tag: "Success", value: { sequence: 42 } },
          }),
        );
      });
    });
    try {
      const result = dispatchT3Command({
        origin: `http://127.0.0.1:${server.address().port}`,
        token: "credential",
        command,
      });
      if (rejected) await assert.rejects(result, /rejected/);
      else assert.deepEqual(await result, { sequence: 42 });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
}
