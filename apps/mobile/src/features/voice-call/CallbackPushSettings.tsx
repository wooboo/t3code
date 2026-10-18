import { useState } from "react";
import { Platform, Pressable, View } from "react-native";
import * as Option from "effect/Option";
import type { EnvironmentId } from "@t3tools/contracts";
import { usePreparedConnection } from "../../state/session";
import { AppText as Text } from "../../components/ui/AppText";
import {
  callbackPushState,
  registerCallbackDevice,
  unregisterCallbackDevice,
} from "./callbackDevice";

export function CallbackPushSettings({ environmentId }: { environmentId: EnvironmentId }) {
  const prepared = usePreparedConnection(environmentId);
  const connection = Option.getOrNull(prepared);
  const token =
    connection?.httpAuthorization?._tag === "Bearer" ? connection.httpAuthorization.token : null;
  const [enabled, setEnabled] = useState(() => callbackPushState(environmentId).enabled);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(() => callbackPushState(environmentId).error);
  if (Platform.OS !== "android") return null;
  const change = async (enable: boolean, pick = false) => {
    if (!connection || !token) return;
    setBusy(true);
    setMessage("");
    try {
      if (enable)
        await registerCallbackDevice(connection.httpBaseUrl, token, environmentId, {
          enable: true,
          pick,
        });
      else await unregisterCallbackDevice(connection.httpBaseUrl, token, environmentId);
      setEnabled(enable);
      setMessage(
        enable ? "Telefon zarejestrowany. Agent może oddzwonić." : "Oddzwanianie wyłączone.",
      );
    } catch (error) {
      setEnabled(callbackPushState(environmentId).enabled);
      setMessage(error instanceof Error ? error.message : "Nie udało się zmienić ustawień.");
    } finally {
      setBusy(false);
    }
  };
  const disabled = busy || !token;
  return (
    <View className="gap-3 border-t border-border pt-5">
      <Text className="text-lg font-bold">Oddzwanianie</Text>
      <Text className="text-sm text-foreground-secondary">
        Powiadomienia o połączeniach przychodzących. Serwer wybiera Firebase lub UnifiedPush.
        Firebase nie wymaga aplikacji ntfy.
      </Text>
      <Text accessibilityLiveRegion="polite">
        {busy
          ? "Rejestrowanie telefonu…"
          : message ||
            (enabled
              ? "Oddzwanianie włączone. Ponów rejestrację, aby sprawdzić połączenie."
              : "Oddzwanianie wyłączone.")}
      </Text>
      {!token ? (
        <Text>Połącz się bezpośrednio z serwerem głosowym, aby skonfigurować oddzwanianie.</Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        disabled={disabled}
        onPress={() => void change(true)}
        className="min-h-12 items-center justify-center rounded-full bg-primary px-5 py-3 disabled:opacity-50"
      >
        <Text className="font-bold text-primary-foreground">
          {enabled ? "Ponów rejestrację" : "Włącz oddzwanianie"}
        </Text>
      </Pressable>
      {enabled ? (
        <>
          {!callbackPushState(environmentId).token ? (
            <Pressable
              accessibilityRole="button"
              disabled={disabled}
              onPress={() => void change(true, true)}
              className="min-h-12 items-center justify-center rounded-full bg-subtle px-5 py-3 disabled:opacity-50"
            >
              <Text>Zmień dostawcę push</Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            disabled={disabled}
            onPress={() => void change(false)}
            className="min-h-12 items-center justify-center px-5 py-3 disabled:opacity-50"
          >
            <Text>Wyłącz oddzwanianie</Text>
          </Pressable>
        </>
      ) : null}
    </View>
  );
}
