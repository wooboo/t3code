import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { createFcmPush } from "../prototype/fcm-push.mjs";
import { IncomingCalls } from "../prototype/incoming-calls.mjs";
const device = {
  deviceId: "phone",
  hostEnvironmentId: "host",
  provider: "fcm",
  projectId: "voice-project",
  token: "device-token",
};
function fixture(t, fetcher) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fcm-"));
  t.after(() => NodeFS.rmSync(dir, { recursive: true, force: true }));
  const file = NodePath.join(dir, "credentials.json");
  NodeFS.writeFileSync(
    file,
    JSON.stringify({ type: "service_account", project_id: "voice-project" }),
  );
  const send = createFcmPush(file, {
    fetcher,
    auth: { getAccessToken: async () => "test-access-token" },
  });
  const calls = new IncomingCalls(NodePath.join(dir, "calls.json"), { send });
  calls.register("owner", device);
  return { send, calls };
}
NodeTest.test(
  "voice results use a normal long-lived data notification without conversation content",
  async (t) => {
    const requests = [];
    const { calls } = fixture(t, async (_url, init) => {
      requests.push(JSON.parse(init.body).message);
      return Response.json({ name: "projects/voice-project/messages/result" });
    });
    await calls.notifyResult(
      { ownerId: "owner", environmentId: "env", threadId: "thread" },
      "agent:result-1",
    );
    NodeAssert.equal(requests[0].android.ttl, "86400s");
    NodeAssert.equal(requests[0].data.t3_kind, "voice_result");
    NodeAssert.equal(requests[0].data.messageId, "agent:result-1");
    NodeAssert.equal(requests[0].data.threadId, "thread");
    NodeAssert.equal(requests[0].data.hostEnvironmentId, "host");
    NodeAssert.equal(requests[0].notification, undefined);
    NodeAssert.equal(Object.keys(calls.state.calls).length, 0);
  },
);
NodeTest.test(
  "FCM sends a high-priority, short-lived data invitation without conversation content",
  async (t) => {
    const requests = [];
    const { calls, send } = fixture(t, async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body), headers: init.headers });
      return Response.json({ name: "projects/voice-project/messages/test" });
    });
    NodeAssert.deepEqual(send.config, { provider: "fcm", projectId: "voice-project" });
    const result = await calls.request(
      { ownerId: "owner", environmentId: "env", threadId: "thread" },
      "Private reason",
      "Private context",
    );
    NodeAssert.equal(result.status, "ring_requested");
    NodeAssert.equal(requests.length, 1);
    NodeAssert.equal(
      requests[0].url,
      "https://fcm.googleapis.com/v1/projects/voice-project/messages:send",
    );
    NodeAssert.deepEqual(requests[0].body.message.android, { priority: "HIGH", ttl: "45s" });
    NodeAssert.equal(requests[0].body.message.notification, undefined);
    NodeAssert.equal(requests[0].body.message.data.callId, result.callId);
    NodeAssert.equal(requests[0].body.message.data.hostEnvironmentId, "host");
    NodeAssert.equal(JSON.stringify(requests[0]).includes("Private"), false);
    NodeAssert.equal((await calls.request({ ownerId: "owner" }, "again")).status, "busy");
  },
);
NodeTest.test(
  "only FCM UNREGISTERED retires the phone, not project or permission errors",
  async (t) => {
    for (const code of ["UNREGISTERED", "SENDER_ID_MISMATCH", "PERMISSION_DENIED"]) {
      const { calls } = fixture(t, async () =>
        Response.json(
          {
            error: {
              details: [
                {
                  "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError",
                  errorCode: code,
                },
              ],
            },
          },
          { status: 404 },
        ),
      );
      const result = await calls.request({ ownerId: "owner" }, "call");
      NodeAssert.equal(result.status, "unavailable");
      NodeAssert.equal(Boolean(calls.state.devices.owner), code !== "UNREGISTERED");
    }
  },
);
NodeTest.test("FCM rejects registrations from another project without sending", async (t) => {
  const { calls } = fixture(t, async () => {
    throw Error("must not send");
  });
  calls.register("owner", { ...device, projectId: "other-project" });
  NodeAssert.equal((await calls.request({ ownerId: "owner" }, "call")).status, "unavailable");
});
