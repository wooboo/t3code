import { test } from "node:test";
import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCallPush, validateCallbackDevice } from "../prototype/call-push.mjs";
import { pushDevice } from "./push-fixtures.mjs";
const require = createRequire(import.meta.url);
const ece = createRequire(require.resolve("web-push"))("http_ece");

test("delivers encrypted Web Push to the selected server and retains its VAPID identity", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "t3-webpush-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "vapid.json");
  const requests = [];
  const send = createCallPush(file, async (url, init) => {
    requests.push({ url, init });
    return new Response(null, { status: 201 });
  });
  const pair = createECDH("prime256v1");
  pair.generateKeys();
  const auth = randomBytes(16);
  const device = pushDevice({
    subscription: {
      endpoint: "https://private-ntfy.test/up-123",
      keys: {
        p256dh: pair.getPublicKey().toString("base64url"),
        auth: auth.toString("base64url"),
      },
    },
  });
  await send(device, { callId: "invitation", expiresAt: "12345" });
  assert.equal(createCallPush(file).publicKey, send.publicKey);
  assert.equal(requests.length, 1);
  const { url, init } = requests[0];
  assert.equal(url, device.subscription.endpoint);
  assert.equal(init.headers.TTL, 45);
  assert.equal(init.headers.Urgency, "high");
  assert.equal(init.headers["Content-Encoding"], "aes128gcm");
  assert.ok(init.headers.Authorization.startsWith("vapid "));
  assert.equal(init.redirect, "error");
  assert.equal(init.body.includes(Buffer.from("invitation")), false);
  const message = ece.decrypt(init.body, {
    version: "aes128gcm",
    privateKey: pair,
    authSecret: auth,
  });
  assert.deepEqual(JSON.parse(message.toString()), {
    t3_kind: "voice_call",
    hostEnvironmentId: "host",
    callId: "invitation",
    expiresAt: "12345",
  });
});
test("rejects old FCM registrations, unencrypted subscriptions and unsafe endpoint schemes", () => {
  assert.throws(() =>
    validateCallbackDevice({ deviceId: "phone", token: "old", hostEnvironmentId: "host" }),
  );
  const device = pushDevice();
  for (const endpoint of [
    "http://ntfy.test/topic",
    "file:///etc/passwd",
    "https://user:secret@ntfy.test/topic",
  ]) {
    assert.throws(() =>
      validateCallbackDevice({ ...device, subscription: { ...device.subscription, endpoint } }),
    );
  }
  assert.throws(() =>
    validateCallbackDevice({ ...device, subscription: { endpoint: device.subscription.endpoint } }),
  );
});
