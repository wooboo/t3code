import { createECDH, randomBytes } from "node:crypto";
export function pushDevice(overrides = {}) {
  const pair = createECDH("prime256v1");
  pair.generateKeys();
  return {
    deviceId: "phone",
    hostEnvironmentId: "host",
    subscription: {
      endpoint: "https://push.example.test/up-secret",
      keys: {
        p256dh: pair.getPublicKey().toString("base64url"),
        auth: randomBytes(16).toString("base64url"),
      },
    },
    ...overrides,
  };
}
