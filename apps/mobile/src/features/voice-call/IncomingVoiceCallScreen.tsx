import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { useFocusEffect, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { EnvironmentId, VoiceCallInvitation } from "@t3tools/contracts";
import { AppText as Text } from "../../components/ui/AppText";
import { usePreparedConnection } from "../../state/session";
import { useVoiceCall } from "./useVoiceCall";
import { VoiceCallPanel } from "./VoiceCallPanel";
import { VoiceEnvironmentContext } from "./VoiceEnvironmentContext";
import { dismissIncomingCall, setIncomingCallVisible } from "./callbackDevice";

type Invitation = VoiceCallInvitation;
const decodeInvitation = Schema.decodeUnknownSync(VoiceCallInvitation);
type Props = StaticScreenProps<{ hostEnvironmentId: string; callId: string; action?: string }>;

export function IncomingVoiceCallScreen(props: Props) {
  const { hostEnvironmentId, callId, action } = props.route.params;
  return <IncomingInvitation key={`${hostEnvironmentId}:${callId}:${action}`} {...props} />;
}

function IncomingInvitation({ route }: Props) {
  const params = route.params;
  const prepared = usePreparedConnection(EnvironmentId.make(params.hostEnvironmentId));
  const connection = Option.getOrNull(prepared);
  const token =
    connection?.httpAuthorization?._tag === "Bearer" ? connection.httpAuthorization.token : null;
  const baseUrl = connection?.httpBaseUrl;
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [error, setError] = useState("");
  const navigation = useNavigation();
  useFocusEffect(
    useCallback(() => {
      setIncomingCallVisible(true);
      return () => setIncomingCallVisible(false);
    }, []),
  );
  useEffect(() => {
    if (params.action === "answer" || params.action === "decline") dismissIncomingCall();
    if (!token || !baseUrl) return;
    const abort = new AbortController();
    const url = new URL(
      `voice/livekit/incoming/${encodeURIComponent(params.callId)}`,
      baseUrl.replace(/\/?$/, "/"),
    );
    void (async () => {
      const response = await fetch(url, {
        method: params.action === "decline" ? "DELETE" : "GET",
        headers: { authorization: `Bearer ${token}` },
        signal: abort.signal,
      });
      if (params.action === "decline") {
        if (!response.ok) throw Error("Ta rozmowa już nie dzwoni.");
        setError("Połączenie odrzucone.");
        return;
      }
      if (!response.ok) throw Error("To połączenie jest już niedostępne.");
      const call = decodeInvitation(await response.json());
      if (call.status !== "pending" || call.expiresAt <= Date.now())
        throw Error("Połączenie nieodebrane lub zakończone.");
      if (call.id !== params.callId) throw Error("Nieprawidłowe połączenie.");
      if (!abort.signal.aborted) setInvitation(call);
    })().catch((cause) => {
      if (!abort.signal.aborted) {
        dismissIncomingCall();
        setError(cause instanceof Error ? cause.message : "Nie można odebrać połączenia.");
      }
    });
    return () => abort.abort();
  }, [baseUrl, token, params.callId, params.action]);

  if (invitation && baseUrl && token)
    return (
      <IncomingCall
        key={invitation.id}
        invitation={invitation}
        hostEnvironmentId={EnvironmentId.make(params.hostEnvironmentId)}
        answer={params.action === "answer"}
        baseUrl={baseUrl}
        token={token}
      />
    );
  return (
    <View className="flex-1 bg-screen items-center justify-center gap-6 px-6">
      <Text>{error || "Łączenie z serwerem rozmowy…"}</Text>
      <Pressable
        className="min-h-12 items-center justify-center rounded-full bg-subtle px-8 py-3"
        accessibilityRole="button"
        onPress={() => navigation.navigate("Home")}
      >
        <Text>Wróć</Text>
      </Pressable>
    </View>
  );
}

function IncomingCall({
  invitation,
  hostEnvironmentId,
  answer,
  baseUrl,
  token,
}: {
  invitation: Invitation;
  hostEnvironmentId: EnvironmentId;
  answer: boolean;
  baseUrl: string;
  token: string;
}) {
  const call = useVoiceCall({
    environmentId: EnvironmentId.make(invitation.environmentId),
    threadId: invitation.threadId,
    hostEnvironmentId,
    callbackId: invitation.id,
  });
  const navigation = useNavigation();
  const [accepted, setAccepted] = useState(answer);
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState("");
  const started = useRef(false);
  const { start: startCall, supported } = call;
  useEffect(() => {
    if (accepted) dismissIncomingCall();
    if (accepted && supported && !started.current) {
      started.current = true;
      void startCall();
    }
  }, [accepted, supported, startCall]);
  useEffect(() => {
    const timer = setTimeout(
      () => {
        dismissIncomingCall();
        setExpired(true);
      },
      Math.max(0, invitation.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [invitation.expiresAt]);
  const decline = async () => {
    dismissIncomingCall();
    try {
      const response = await fetch(
        new URL(
          `voice/livekit/incoming/${encodeURIComponent(invitation.id)}`,
          baseUrl.replace(/\/?$/, "/"),
        ),
        {
          method: "DELETE",
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(10000),
        },
      );
      if (!response.ok && response.status !== 409) throw Error("Nie można odrzucić połączenia.");
      navigation.navigate("Home");
    } catch {
      setError("Nie można odrzucić połączenia. Spróbuj ponownie.");
    }
  };
  if (accepted)
    return (
      <VoiceCallPanel
        call={call}
        canStart={false}
        onClose={() => {
          call.stop();
          navigation.navigate("Home");
        }}
      />
    );
  return (
    <View className="flex-1 bg-screen items-center justify-center gap-8 px-6">
      <Text className="text-2xl font-bold">
        {expired ? "Połączenie nieodebrane" : "Agent dzwoni"}
      </Text>
      <Text>{invitation.reason}</Text>
      <VoiceEnvironmentContext
        environmentId={EnvironmentId.make(invitation.environmentId)}
        hostEnvironmentId={hostEnvironmentId}
      />
      {error ? <Text>{error}</Text> : null}
      {!expired ? (
        <>
          <Pressable
            className="min-h-14 w-full max-w-sm items-center justify-center rounded-full bg-primary px-8 py-4"
            accessibilityRole="button"
            onPress={() => setAccepted(true)}
          >
            <Text className="text-xl font-bold text-primary-foreground">Odbierz</Text>
          </Pressable>
          <Pressable
            className="min-h-14 w-full max-w-sm items-center justify-center rounded-full bg-danger px-8 py-4"
            accessibilityRole="button"
            onPress={() => void decline()}
          >
            <Text className="font-bold text-danger-foreground">Odrzuć</Text>
          </Pressable>
        </>
      ) : (
        <Pressable
          className="min-h-12 items-center justify-center rounded-full bg-subtle px-8 py-3"
          accessibilityRole="button"
          onPress={() => navigation.navigate("Home")}
        >
          <Text>Wróć</Text>
        </Pressable>
      )}
    </View>
  );
}
