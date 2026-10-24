import * as NodeFS from "node:fs";
import { GoogleAuth } from "google-auth-library";
import { validateCallbackDevice } from "./call-push.mjs";

export function createFcmPush(file, { fetcher = fetch, auth } = {}) {
  const credentials = JSON.parse(NodeFS.readFileSync(file, "utf8"));
  const projectId = credentials.project_id;
  if (
    credentials.type !== "service_account" ||
    typeof projectId !== "string" ||
    !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(projectId)
  )
    throw Error("Invalid Firebase service account project");
  const client =
    auth ??
    new GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/firebase.messaging"],
    });
  const supports = (device) => device.provider === "fcm" && device.projectId === projectId;
  const send = async (input, invitation, { kind = "voice_call", ttlSeconds = 45 } = {}) => {
    const device = validateCallbackDevice(input);
    if (!supports(device)) throw Error("Register this phone with the configured Firebase project");
    const token = await client.getAccessToken();
    if (!token) throw Error("Firebase authentication failed");
    const response = await fetcher(
      `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(10000),
        body: JSON.stringify({
          message: {
            token: device.token,
            android: { priority: "HIGH", ttl: `${ttlSeconds}s` },
            data: {
              t3_kind: kind,
              hostEnvironmentId: device.hostEnvironmentId,
              ...invitation,
            },
          },
        }),
      },
    );
    const result = await response.json();
    if (!response.ok) {
      const unregistered = result.error?.details?.some(
        (detail) =>
          detail["@type"] === "type.googleapis.com/google.firebase.fcm.v1.FcmError" &&
          detail.errorCode === "UNREGISTERED",
      );
      // Only an explicitly retired token invalidates the saved phone registration.
      throw Object.assign(Error("FCM delivery could not be confirmed"), {
        status: unregistered ? 410 : 502,
      });
    }
    if (typeof result.name !== "string") throw Error("FCM did not acknowledge the message");
  };
  return Object.assign(send, { config: { provider: "fcm", projectId }, supports });
}
