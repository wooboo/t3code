import { useEffect } from "react";
import { AppState, Platform } from "react-native";
import * as Option from "effect/Option";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEnvironments } from "../../state/environments";
import { usePreparedConnection } from "../../state/session";
import {
  registerCallbackDevice,
  subscribeCallbackPushChanges,
  syncCallbackPush,
} from "./callbackDevice";

function Registration({ environmentId }: { environmentId: EnvironmentId }) {
  const prepared = usePreparedConnection(environmentId);
  const connection = Option.getOrNull(prepared);
  const baseUrl = connection?.httpBaseUrl;
  const token =
    connection?.httpAuthorization?._tag === "Bearer" ? connection.httpAuthorization.token : null;
  useEffect(() => {
    if (!baseUrl?.startsWith("https://") || !token) return;
    const refresh = () => {
      void registerCallbackDevice(baseUrl, token, environmentId).catch(() => undefined);
    };
    const changed = subscribeCallbackPushChanges(environmentId, () => {
      void syncCallbackPush(baseUrl, token, environmentId).catch(() => undefined);
    });
    const active = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });
    if (AppState.currentState === "active") refresh();
    return () => {
      changed?.remove();
      active.remove();
    };
  }, [baseUrl, token, environmentId]);
  return null;
}
export function CallbackPushRegistration() {
  const { environments } = useEnvironments();
  return Platform.OS === "android" ? (
    <>
      {environments.map(({ environmentId }) => (
        <Registration key={environmentId} environmentId={environmentId} />
      ))}
    </>
  ) : null;
}
