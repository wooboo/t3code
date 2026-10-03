import { VoicePushSubscription } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import Constants from "expo-constants";
import { requireOptionalNativeModule } from "expo";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { loadOrCreateAgentAwarenessDeviceId } from "../../persistence/imperative";

interface CallNotifications {
  configureVoiceCalls?(scheme: string): void;
  dismissVoiceCall?(): void;
  setIncomingCallVisible?(visible: boolean): void;
  getVoiceFcmState?(instance: string): string;
  registerVoiceFcm?(instance: string, projectId: string): Promise<string>;
  unregisterVoiceFcm?(instance: string): void;
  getVoicePushState?(instance: string): string;
  registerVoicePush?(
    instance: string,
    vapid: string,
    pick: boolean,
    interactive: boolean,
  ): Promise<string>;
  addListener(
    event: "voicePushChanged",
    callback: (event: { instance: string }) => void,
  ): { remove(): void };
  unregisterVoicePush?(instance: string): void;
}
const decodeSubscription = Schema.decodeUnknownSync(Schema.fromJsonString(VoicePushSubscription));
const decodeState = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      enabled: Schema.Boolean,
      error: Schema.String,
      subscription: Schema.optional(VoicePushSubscription),
      token: Schema.optional(Schema.String),
      projectId: Schema.optional(Schema.String),
    }),
  ),
);
function native() {
  return Platform.OS === "android"
    ? requireOptionalNativeModule<CallNotifications>("T3AgentNotifications")
    : null;
}
export function setIncomingCallVisible(visible: boolean) {
  native()?.setIncomingCallVisible?.(visible);
}
export function dismissIncomingCall() {
  native()?.dismissVoiceCall?.();
}
export function callbackPushState(hostEnvironmentId: string) {
  const fcm = native()?.getVoiceFcmState?.(hostEnvironmentId);
  if (fcm) {
    const state = decodeState(fcm);
    if (state.enabled) return state;
  }
  const state = native()?.getVoicePushState?.(hostEnvironmentId);
  return state ? decodeState(state) : { enabled: false, error: "" };
}
const registrations = new Map<string, Promise<void>>();
const revisions = new Map<string, number>();
const url = (base: string, path: string) =>
  new URL(`voice/livekit/${path}`, base.replace(/\/?$/, "/"));

/** Only an explicit opt-in opens the distributor picker; routine refresh never enables callbacks. */
export function registerCallbackDevice(
  baseUrl: string,
  bearerToken: string,
  hostEnvironmentId: string,
  options: { enable?: boolean; pick?: boolean } = {},
) {
  const key = JSON.stringify([baseUrl, hostEnvironmentId]);
  const pending = registrations.get(key);
  if (pending) return pending;
  const revision = revisions.get(key) ?? 0;
  const operation = (async () => {
    const bridge = native();
    if (!bridge?.registerVoicePush && !bridge?.registerVoiceFcm) {
      if (options.enable) throw Error("Zaktualizuj aplikację, aby włączyć oddzwanianie.");
      return;
    }
    if (!options.enable && !callbackPushState(hostEnvironmentId).enabled) return;
    if (!baseUrl.startsWith("https://")) throw Error("Oddzwanianie wymaga połączenia HTTPS.");
    let permission = await Notifications.getPermissionsAsync();
    if (!permission.granted && options.enable)
      permission = await Notifications.requestPermissionsAsync();
    if (!permission.granted) throw Error("Zezwól na powiadomienia o połączeniach.");
    const scheme = Constants.expoConfig?.scheme;
    bridge.configureVoiceCalls?.((Array.isArray(scheme) ? scheme[0] : scheme) ?? "t3code");
    const headers = { authorization: `Bearer ${bearerToken}`, "content-type": "application/json" };
    const config = await fetch(url(baseUrl, "push-config"), {
      headers,
      signal: AbortSignal.timeout(10000),
    });
    if (!config.ok)
      throw Error("Serwer nie udostępnia powiadomień o połączeniach. Zaktualizuj serwer T3.");
    const pushConfig = await config.json();
    if ((revisions.get(key) ?? 0) !== revision) return;
    let registration:
      | { subscription: typeof VoicePushSubscription.Type }
      | { provider: "fcm"; token: string; projectId: string };
    if (pushConfig.provider === "fcm") {
      if (!bridge.registerVoiceFcm) throw Error("Zaktualizuj aplikację, aby włączyć Firebase.");
      if (typeof pushConfig.projectId !== "string" || !pushConfig.projectId)
        throw Error("Nieprawidłowy projekt Firebase.");
      const token = await bridge.registerVoiceFcm(hostEnvironmentId, pushConfig.projectId);
      if (!token) throw Error("Firebase nie zwrócił adresu telefonu.");
      registration = { provider: "fcm", token, projectId: pushConfig.projectId };
    } else {
      const { vapidPublicKey } = pushConfig;
      if (typeof vapidPublicKey !== "string" || !/^[\w-]{87}$/.test(vapidPublicKey))
        throw Error("Nieprawidłowy klucz serwera push.");
      if (!bridge.registerVoicePush) throw Error("Ta aplikacja nie obsługuje UnifiedPush.");
      registration = {
        subscription: decodeSubscription(
          await bridge.registerVoicePush(
            hostEnvironmentId,
            vapidPublicKey,
            options.pick === true,
            options.enable === true,
          ),
        ),
      };
    }
    const deviceId = await loadOrCreateAgentAwarenessDeviceId();
    if ((revisions.get(key) ?? 0) !== revision) return;
    const response = await fetch(url(baseUrl, "device"), {
      method: "POST",
      headers,
      body: JSON.stringify({
        deviceId,
        ...registration,
        hostEnvironmentId,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok)
      throw Error("Nie udało się zapisać telefonu do oddzwaniania. Ponów rejestrację.");
    if ((revisions.get(key) ?? 0) !== revision) return;
    const previous =
      pushConfig.provider === "fcm"
        ? bridge.getVoicePushState?.(hostEnvironmentId)
        : bridge.getVoiceFcmState?.(hostEnvironmentId);
    if (previous && decodeState(previous).enabled) {
      if (pushConfig.provider === "fcm") bridge.unregisterVoicePush?.(hostEnvironmentId);
      else bridge.unregisterVoiceFcm?.(hostEnvironmentId);
    }
  })().finally(() => {
    if (registrations.get(key) === operation) registrations.delete(key);
  });
  registrations.set(key, operation);
  return operation;
}
export async function unregisterCallbackDevice(
  baseUrl: string,
  bearerToken: string,
  hostEnvironmentId: string,
) {
  const key = JSON.stringify([baseUrl, hostEnvironmentId]);
  revisions.set(key, (revisions.get(key) ?? 0) + 1);
  native()?.unregisterVoiceFcm?.(hostEnvironmentId);
  native()?.unregisterVoicePush?.(hostEnvironmentId);
  // Drain a POST already in flight before deleting it, so a late reply cannot re-enable the server.
  await registrations.get(key)?.catch(() => undefined);
  const endpoint = url(baseUrl, "device");
  endpoint.searchParams.set("deviceId", await loadOrCreateAgentAwarenessDeviceId());
  const response = await fetch(endpoint, {
    method: "DELETE",
    headers: { authorization: `Bearer ${bearerToken}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok)
    throw Error(
      "Telefon przestał odbierać połączenia, ale serwer nie potwierdził wyłączenia. Spróbuj ponownie.",
    );
}

export function subscribeCallbackPushChanges(hostEnvironmentId: string, callback: () => void) {
  return native()?.addListener("voicePushChanged", (event) => {
    if (event.instance === hostEnvironmentId) callback();
  });
}

/** Endpoint rotations can arrive while JS sleeps; sync the native snapshot without re-registering. */
export function syncCallbackPush(baseUrl: string, bearerToken: string, hostEnvironmentId: string) {
  const key = JSON.stringify([baseUrl, hostEnvironmentId]);
  if (registrations.has(key)) return registrations.get(key)!;
  const revision = revisions.get(key) ?? 0;
  const operation = (async () => {
    const state = callbackPushState(hostEnvironmentId);
    const deviceId = await loadOrCreateAgentAwarenessDeviceId();
    if ((revisions.get(key) ?? 0) !== revision) return;
    const endpoint = url(baseUrl, "device");
    if (!state.enabled) endpoint.searchParams.set("deviceId", deviceId);
    if (state.enabled && !state.subscription && !state.token) return;
    const registration =
      state.token && state.projectId
        ? { provider: "fcm", token: state.token, projectId: state.projectId }
        : { subscription: state.subscription };
    const response = await fetch(endpoint, {
      method: state.enabled ? "POST" : "DELETE",
      headers: { authorization: `Bearer ${bearerToken}`, "content-type": "application/json" },
      body: state.enabled
        ? JSON.stringify({ deviceId, hostEnvironmentId, ...registration })
        : undefined,
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw Error("Nie udało się odświeżyć adresu push.");
  })().finally(() => {
    if (registrations.get(key) === operation) registrations.delete(key);
  });
  registrations.set(key, operation);
  return operation;
}
