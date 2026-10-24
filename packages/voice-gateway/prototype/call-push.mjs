import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import webpush from "web-push";

export function validateCallbackDevice(device) {
  const bounded = (s) => typeof s === "string" && s.length > 0 && s.length <= 4096;
  if (!bounded(device?.deviceId) || !bounded(device?.hostEnvironmentId))
    throw Error("Invalid UnifiedPush device");
  if (device.provider === "fcm") {
    if (
      !bounded(device.token) ||
      typeof device.projectId !== "string" ||
      !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(device.projectId)
    )
      throw Error("Invalid Firebase device");
    return {
      deviceId: device.deviceId,
      hostEnvironmentId: device.hostEnvironmentId,
      provider: "fcm",
      token: device.token,
      projectId: device.projectId,
    };
  }
  if (device.provider !== undefined && device.provider !== "unifiedpush")
    throw Error("Unknown push provider");
  if (!bounded(device.subscription?.endpoint)) throw Error("Invalid UnifiedPush endpoint");
  const url = new URL(device.subscription.endpoint);
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    throw Error("UnifiedPush requires an HTTPS endpoint");
  const keys = device.subscription.keys;
  if (!keys || !/^[\w-]{87}$/.test(keys.p256dh) || !/^[\w-]{22}$/.test(keys.auth))
    throw Error("Invalid Web Push keys");
  NodeCrypto.ECDH.convertKey(Buffer.from(keys.p256dh, "base64url"), "prime256v1");
  return {
    deviceId: device.deviceId,
    hostEnvironmentId: device.hostEnvironmentId,
    subscription: { endpoint: url.href, keys: { p256dh: keys.p256dh, auth: keys.auth } },
  };
}

/** RFC 8291 encryption, delivered directly to the user's UnifiedPush endpoint. */
export function createCallPush(file, fetcher = fetch) {
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true, mode: 0o700 });
  if (!NodeFS.existsSync(file))
    NodeFS.writeFileSync(file, JSON.stringify(webpush.generateVAPIDKeys()), {
      mode: 0o600,
      flag: "wx",
    });
  const keys = JSON.parse(NodeFS.readFileSync(file, "utf8"));
  const send = async (device, invitation, { kind = "voice_call", ttlSeconds = 45 } = {}) => {
    const { subscription } = validateCallbackDevice(device);
    const details = webpush.generateRequestDetails(
      subscription,
      JSON.stringify({
        t3_kind: kind,
        hostEnvironmentId: device.hostEnvironmentId,
        ...invitation,
      }),
      {
        TTL: ttlSeconds,
        urgency: "high",
        contentEncoding: "aes128gcm",
        vapidDetails: { subject: "https://t3.codes", ...keys },
      },
    );
    const response = await fetcher(details.endpoint, {
      method: "POST",
      headers: details.headers,
      body: details.body,
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok)
      throw Object.assign(Error("UnifiedPush delivery failed"), { status: response.status });
  };
  return Object.assign(send, {
    publicKey: keys.publicKey,
    config: { provider: "unifiedpush", vapidPublicKey: keys.publicKey },
    supports: (device) => device.provider !== "fcm",
  });
}
