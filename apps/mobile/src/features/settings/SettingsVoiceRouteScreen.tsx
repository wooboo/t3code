import { CallbackPushSettings } from "../voice-call/CallbackPushSettings";
import { useServerConfigs } from "../../state/entities";
import { useVoiceHost } from "../voice-call/useVoiceHost";
import * as Option from "effect/Option";
import { useEffect, useState } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Menu as ControlPillMenu } from "../../components/ui/Menu";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Platform, Pressable, ScrollView, Switch, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type {
  EnvironmentId,
  VoiceAgentSettings,
  VoiceAgentSettingsSnapshot,
  ModelSelection,
  ServerProvider,
} from "@t3tools/contracts";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { AndroidScreenHeader } from "../../components/ui/AndroidScreenHeader";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useEnvironments } from "../../state/environments";
import { usePreparedConnection } from "../../state/session";

export function SettingsVoiceRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { environments } = useEnvironments();
  const voiceHost = useVoiceHost();
  const configs = useServerConfigs();
  const selected = voiceHost.environmentId;
  const environment = environments.find((e) => e.environmentId === selected) ?? environments[0];
  return (
    <View className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Voice" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 24 }}
        keyboardShouldPersistTaps="handled"
      >
        <VoiceSelect
          label="Voice server"
          value={selected}
          options={[
            { value: null, label: "Current thread’s environment" },
            ...environments.map((e) => ({
              value: e.environmentId,
              label: `${e.label}${configs.get(e.environmentId)?.environment.capabilities.voiceCallbacks ? " · Full voice server" : configs.get(e.environmentId)?.environment.capabilities.voice ? " · Voice server" : ""}`,
              detail: e.displayUrl ?? undefined,
            })),
          ]}
          onChange={(value) => voiceHost.select(value)}
        />
        <Text className="text-sm text-foreground-secondary">
          The voice server handles audio. Tasks run in the thread’s environment. For full voice with
          agent callbacks, open a thread on the selected full voice server and enable callbacks
          below. Selecting this server does not move existing threads.
        </Text>
        {environment ? (
          <CallbackPushSettings
            key={environment.environmentId}
            environmentId={environment.environmentId}
          />
        ) : null}
        {environment ? (
          <VoiceConfiguration
            key={environment.environmentId}
            environmentId={environment.environmentId}
          />
        ) : (
          <Text className="text-sm text-foreground-secondary">
            Add and connect a T3 environment.
          </Text>
        )}
      </ScrollView>
    </View>
  );
}
function VoiceConfiguration({ environmentId }: { environmentId: EnvironmentId }) {
  const prepared = usePreparedConnection(environmentId);
  const connection = Option.isSome(prepared) ? prepared.value : null;
  const baseUrl = connection?.httpBaseUrl;
  const token =
    connection?.httpAuthorization?._tag === "Bearer" ? connection.httpAuthorization.token : null;
  const [snapshot, setSnapshot] = useState<VoiceAgentSettingsSnapshot | null>(null);
  const [draft, setDraft] = useState<VoiceAgentSettings | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [instructions, setInstructions] = useState("");
  const [originalInstructions, setOriginalInstructions] = useState("");
  const [providers, setProviders] = useState<ServerProvider[]>([]);
  const [modelSelection, setModelSelection] = useState<ModelSelection | null>(null);
  const [originalSelection, setOriginalSelection] = useState<ModelSelection | null>(null);
  const [llmKey, setLlmKey] = useState<string | undefined>();
  const url = (route: string) => new URL(`voice/${route}`, `${baseUrl?.replace(/\/$/, "")}/`).href;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  useEffect(() => {
    if (!baseUrl || !token) return;
    const abort = new AbortController();
    void Promise.all([
      fetch(new URL("voice/agent-settings", `${baseUrl.replace(/\/$/, "")}/`), {
        headers: { Authorization: `Bearer ${token}` },
        signal: abort.signal,
      }),
      fetch(new URL("voice/t3-global-settings", `${baseUrl.replace(/\/$/, "")}/`), {
        headers: { Authorization: `Bearer ${token}` },
        signal: abort.signal,
      }),
    ])
      .then(async ([services, global]) => {
        if (!services.ok || !global.ok)
          throw Error("Could not load voice settings for this environment.");
        const data = (await services.json()) as VoiceAgentSettingsSnapshot;
        const settings = await global.json();
        if (abort.signal.aborted) return;
        setSnapshot(data);
        setDraft(data.config);
        setInstructions(settings.config.instructions.global);
        setOriginalInstructions(settings.config.instructions.global);
        setModelSelection(settings.config.modelSelection);
        setOriginalSelection(settings.config.modelSelection);
        setProviders(
          settings.catalog.providers.filter(
            (p: ServerProvider) =>
              settings.catalog.capabilities?.find(
                (c: { instanceId: string; supported: boolean }) => c.instanceId === p.instanceId,
              )?.supported !== false,
          ),
        );
      })
      .catch((e: unknown) => {
        if (!abort.signal.aborted) setMessage(String(e));
      });
    return () => abort.abort();
  }, [baseUrl, token]);
  if (!token)
    return (
      <Text className="text-sm text-foreground-secondary">
        Connect directly over HTTPS to change voice settings.
      </Text>
    );
  const changed =
    JSON.stringify(draft) !== JSON.stringify(snapshot?.config ?? null) ||
    instructions !== originalInstructions ||
    JSON.stringify(modelSelection) !== JSON.stringify(originalSelection) ||
    llmKey !== undefined;
  function change<K extends keyof VoiceAgentSettings>(key: K, value: VoiceAgentSettings[K]) {
    setDraft((c) => (c ? { ...c, [key]: value } : c));
  }
  const field = (
    key: "llmUrl" | "llmModel" | "sttUrl" | "sttModel" | "ttsUrl" | "ttsModel" | "ttsVoice",
    label: string,
    editable = true,
  ) => (
    <View key={key} className="gap-2">
      <Text className="text-sm font-t3-medium">{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={draft?.[key]}
        editable={editable && !busy}
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={(value) => change(key, value)}
        className="text-base"
      />
    </View>
  );
  async function save() {
    setBusy(true);
    setMessage("");
    try {
      const r = await fetch(url("agent-settings"), {
        method: "PATCH",
        headers,
        body: JSON.stringify({ ...draft, ...(llmKey !== undefined ? { llmKey } : {}) }),
      });
      const data = (await r.json()) as VoiceAgentSettingsSnapshot & { error?: string };
      if (!r.ok) throw Error(data.error || "Could not save settings.");
      setSnapshot(data);
      setDraft(data.config);
      const global = await fetch(url("t3-global-settings"), {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          instructions: { global: instructions },
          modelSelection,
        }),
      });
      if (!global.ok)
        throw Error("Service settings were saved, but instructions could not be saved.");
      setOriginalInstructions(instructions);
      setOriginalSelection(modelSelection);
      setLlmKey(undefined);
      if (data.restartRequired) {
        const restart = await fetch(url("agent-settings/apply"), { method: "POST", headers });
        if (!restart.ok)
          throw Error("Settings saved, but restart failed. Try Save and apply again.");
        setMessage("Settings saved. The environment is restarting. Reconnect to start a new call.");
      } else setMessage("Settings saved. They will be used for the next voice call.");
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {!draft ? (
        <Text className="text-sm text-foreground-secondary">Loading…</Text>
      ) : (
        <>
          <Text className="pt-3 text-base font-t3-bold text-foreground">Conversation agent</Text>
          <VoiceSelect
            label="Conversation provider"
            value={modelSelection?.instanceId ?? null}
            disabled={busy}
            options={[
              { value: null, label: "Custom API" },
              ...providers.map((provider) => ({
                value: provider.instanceId,
                label: provider.displayName || provider.driver,
                disabled: provider.models.length === 0,
              })),
            ]}
            onChange={(instanceId) => {
              if (instanceId === null) return setModelSelection(null);
              const provider = providers.find((p) => p.instanceId === instanceId);
              const model = provider?.models.find((m) => m.isDefault) ?? provider?.models[0];
              if (model) setModelSelection({ instanceId, model: model.slug });
            }}
          />
          {modelSelection ? (
            <VoiceSelect
              label="Conversation model"
              value={modelSelection.model}
              disabled={busy}
              options={(
                providers.find((p) => p.instanceId === modelSelection.instanceId)?.models ?? []
              ).map((model) => ({ value: model.slug, label: model.name }))}
              onChange={(model) => setModelSelection({ ...modelSelection, model })}
            />
          ) : (
            <>
              {field("llmModel", "Model ID")}
              {field("llmUrl", "API URL (empty = OpenCode Go)")}
              <VoiceSelect
                label="API type"
                value={draft.llmApiType}
                disabled={busy}
                options={[
                  { value: "responses", label: "OpenAI Responses" },
                  { value: "chat-completions", label: "OpenAI Chat Completions" },
                ]}
                onChange={(value) => change("llmApiType", value)}
              />
              <Text className="text-sm font-t3-medium">API key</Text>
              <TextInput
                accessibilityLabel="API key"
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                value={llmKey ?? ""}
                onChangeText={setLlmKey}
                placeholder={
                  snapshot?.llmKeyConfigured
                    ? "Saved key · enter a new key to replace"
                    : "API key (optional for local servers)"
                }
                editable={!busy}
                className="text-base"
              />
              {snapshot?.llmKeyConfigured ? (
                <Pressable disabled={busy} onPress={() => setLlmKey("")} className="py-3">
                  <Text className="text-foreground">Remove saved key</Text>
                </Pressable>
              ) : null}
            </>
          )}
          <View className="gap-2">
            <Text className="text-sm font-t3-medium">Agent instructions</Text>
            <TextInput
              accessibilityLabel="Agent instructions"
              placeholder="How should the agent conduct the conversation?"
              textAlignVertical="top"
              multiline
              value={instructions}
              onChangeText={setInstructions}
              editable={!busy}
              className="min-h-32 text-base"
            />
          </View>
          <Text className="pt-3 text-base font-t3-bold text-foreground">Speech recognition</Text>
          {field("sttModel", "STT model")}
          {field("sttUrl", "Transcription API URL")}
          <Text className="pt-3 text-base font-t3-bold text-foreground">Agent voice</Text>
          <VoiceSelect
            label="Speech synthesis"
            value={draft.ttsProvider}
            disabled={busy}
            options={[
              { value: "elevenlabs", label: "ElevenLabs", detail: "Cloud" },
              { value: "breeze", label: "Breeze TTS 2", detail: "Local" },
              { value: "custom", label: "Custom TTS server" },
            ]}
            onChange={(provider) =>
              setDraft((c) =>
                c
                  ? {
                      ...c,
                      ttsProvider: provider,
                      ...(provider === "custom"
                        ? {}
                        : {
                            ttsUrl:
                              provider === "breeze"
                                ? "http://127.0.0.1:18091/v1"
                                : "http://127.0.0.1:18092/v1",
                            ttsModel:
                              provider === "breeze"
                                ? "mlx-community/Breeze-TTS-2-mlx-4bit"
                                : "eleven_flash_v2_5",
                            ttsVoice:
                              provider === "breeze"
                                ? "neutral"
                                : snapshot?.config.ttsProvider === "elevenlabs"
                                  ? snapshot.config.ttsVoice
                                  : "JBFqnCBsd6RMkjVDRZzb",
                            ttsSampleRate: provider === "breeze" ? 24000 : 16000,
                          }),
                    }
                  : c,
              )
            }
          />
          {field("ttsModel", "TTS model", draft.ttsProvider !== "breeze")}
          {field("ttsVoice", "Voice ID", draft.ttsProvider !== "breeze")}
          {field("ttsUrl", "Speech API URL", draft.ttsProvider === "custom")}
          <Text className="text-sm text-foreground-secondary">
            Audio: {draft.ttsSampleRate} Hz. Breeze requires a running local service. API keys stay
            on the server.
          </Text>
          {draft.ttsProvider === "custom" ? (
            <VoiceSelect
              label="Sample rate"
              value={draft.ttsSampleRate}
              disabled={busy}
              options={([16000, 22050, 24000, 44100, 48000] as const).map((rate) => ({
                value: rate,
                label: `${rate} Hz`,
              }))}
              onChange={(value) => change("ttsSampleRate", value)}
            />
          ) : null}
          <Text className="pt-3 text-base font-t3-bold text-foreground">Turn handling</Text>
          <View className="gap-2">
            <Text className="text-sm font-t3-medium">End-of-speech silence (200–2000 ms)</Text>
            <TextInput
              accessibilityLabel="End-of-speech silence in milliseconds"
              keyboardType="number-pad"
              value={String(draft.silenceMs)}
              onChangeText={(value) => change("silenceMs", Number(value))}
              editable={!busy}
              className="text-base"
            />
          </View>
          <View className="flex-row items-center justify-between gap-3">
            <Text className="flex-1 text-foreground">Interrupt the agent when I speak</Text>
            <Switch
              accessibilityLabel="Allow interruptions"
              value={draft.interruptions}
              onValueChange={(value) => change("interruptions", value)}
              disabled={busy}
            />
          </View>
          <Pressable
            accessibilityRole="button"
            disabled={(!changed && !snapshot?.restartRequired) || busy}
            onPress={() => void save()}
            className="min-h-12 items-center justify-center rounded-2xl bg-primary px-4 py-3 disabled:opacity-40"
          >
            <Text className="font-t3-medium text-primary-foreground">
              {busy ? "Saving…" : "Save and apply"}
            </Text>
          </Pressable>
          <Text className="text-sm text-foreground-secondary">
            Settings apply to the next call. Service changes restart the environment and end active
            calls.
          </Text>
          {snapshot?.restartRequired ? (
            <Text className="text-sm text-foreground-secondary">
              Saved settings are waiting for a restart.
            </Text>
          ) : null}
        </>
      )}
      {message ? (
        <Text accessibilityRole="alert" className="text-foreground">
          {message}
        </Text>
      ) : null}
    </>
  );
}

function VoiceSelect<Value extends string | number | null>(props: {
  label: string;
  value: Value;
  options: Array<{ value: Value; label: string; detail?: string; disabled?: boolean }>;
  disabled?: boolean;
  onChange: (value: Value) => void;
}) {
  const selected = props.options.find((option) => option.value === props.value);
  const disabled = props.disabled || props.options.length === 0;
  const content = (
    <View
      accessible
      accessibilityRole="button"
      accessibilityLabel={`${props.label}: ${selected?.label ?? props.value ?? "Select"}`}
      accessibilityState={{ disabled }}
      className={`min-h-13.5 flex-row items-center gap-3 rounded-2xl bg-input px-3.5 py-3 ${disabled ? "opacity-40" : ""}`}
    >
      <View className="min-w-0 flex-1 gap-1">
        <Text className="text-base" numberOfLines={2}>
          {selected?.label ?? props.value ?? "Select"}
        </Text>
        {selected?.detail ? (
          <Text className="text-xs text-foreground-secondary" numberOfLines={2}>
            {selected.detail}
          </Text>
        ) : null}
      </View>
      <SymbolView
        name="chevron.down"
        size={16}
        tintColorClassName="accent-chevron"
        type="monochrome"
      />
    </View>
  );
  return (
    <View className="gap-2">
      <Text className="text-sm font-t3-medium">{props.label}</Text>
      {disabled ? (
        content
      ) : (
        <ControlPillMenu
          title={props.label}
          actions={props.options.map((option, index) => ({
            id: String(index),
            title: option.label,
            subtitle: option.detail,
            state: option.value === props.value ? "on" : "off",
            attributes: { disabled: option.disabled },
          }))}
          onPressAction={({ nativeEvent }) => {
            const option = props.options[Number(nativeEvent.event)];
            if (option && !option.disabled) props.onChange(option.value);
          }}
        >
          {content}
        </ControlPillMenu>
      )}
    </View>
  );
}
