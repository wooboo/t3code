import { usePrimarySettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { EnvironmentId } from "@t3tools/contracts";
import type {
  ModelSelection,
  ProviderInstanceId,
  ServerProvider,
  VoiceCallbackSettings,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { ChevronDownIcon, LoaderCircleIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Checkbox } from "../ui/checkbox";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { ProviderModelPicker } from "./ProviderModelPicker";

export type VoiceSettingsConfig = VoiceCallbackSettings & {
  modelSelection: ModelSelection | null;
  instructions: { global: string; project: string; thread: string };
  enabledSkills: string[];
  terms: Array<{ from: string; to: string }>;
};

type VoiceSettingsResponse = {
  config: VoiceSettingsConfig;
  catalog: {
    providers: ServerProvider[];
    capabilities?: Array<{
      instanceId: string;
      supported: boolean;
      reason?: string;
      streaming: boolean;
    }>;
  };
  context: {
    skills: Array<{ id: string; name: string; path: string }>;
    agents: Array<{ path: string; content: string; truncated?: boolean }>;
    loadedSkills: Array<{ id: string; path: string; content: string }>;
    omittedSkills: Array<{ id: string; name: string; reason: string }>;
    historySummary: string;
    effectiveInstructions: string;
  };
};

type VoiceSettingsPatch = {
  autoCallback?: boolean;
  modelSelection?: ModelSelection | null;
  instructions?: Partial<VoiceSettingsConfig["instructions"]>;
  enabledSkills?: string[];
  terms?: VoiceSettingsConfig["terms"];
};

const DEFAULT_CONFIG: VoiceSettingsConfig = {
  autoCallback: false,
  modelSelection: null,
  instructions: { global: "", project: "", thread: "" },
  enabledSkills: [],
  terms: [],
};

function mergeConfig(config: VoiceSettingsConfig, patch: VoiceSettingsPatch): VoiceSettingsConfig {
  return {
    ...config,
    ...(patch.autoCallback !== undefined ? { autoCallback: patch.autoCallback } : {}),
    ...(patch.modelSelection !== undefined ? { modelSelection: patch.modelSelection } : {}),
    ...(patch.instructions
      ? { instructions: { ...config.instructions, ...patch.instructions } }
      : {}),
    ...(patch.enabledSkills ? { enabledSkills: patch.enabledSkills } : {}),
    ...(patch.terms ? { terms: patch.terms } : {}),
  };
}

function voiceSettingsUrl(threadId: string, environmentId?: string): URL | null {
  const origin = import.meta.env.VITE_VOICE_FRONT_ORIGIN || "/voice/";
  if (!origin) return null;
  const url = new URL(
    threadId === "__global__" ? "t3-global-settings" : "t3-settings",
    new URL(origin, window.location.origin),
  );
  if (threadId !== "__global__") {
    url.searchParams.set("thread", threadId);
    if (environmentId) url.searchParams.set("environmentId", environmentId);
  }
  return url;
}

export function useVoiceSettings(
  threadId: string | null | undefined,
  deferred = false,
  environmentId?: string,
) {
  const scopeKey = `${environmentId ?? ""}:${threadId ?? ""}`;
  const [draft, setDraft] = useState<VoiceSettingsConfig | null>(null);
  const [snapshot, setSnapshot] = useState<{
    threadId: string;
    data: VoiceSettingsResponse;
  } | null>(null);
  const [failure, setFailure] = useState<{ threadId: string; message: string } | null>(null);
  const [savingThreadId, setSavingThreadId] = useState<string | null>(null);
  const currentSnapshot = snapshot?.threadId === scopeKey ? snapshot : null;
  const currentFailure = failure?.threadId === scopeKey ? failure : null;
  // Older gateways may predate newer config fields; fill in defaults client-side.
  const data = currentSnapshot?.data
    ? { ...currentSnapshot.data, config: { ...DEFAULT_CONFIG, ...currentSnapshot.data.config } }
    : null;
  const error = currentFailure?.message ?? "";
  const saving = savingThreadId === scopeKey;

  useEffect(() => {
    const scopedThreadId = threadId;
    if (!scopedThreadId) {
      return;
    }
    const url = voiceSettingsUrl(scopedThreadId, environmentId);
    if (!url) {
      return;
    }
    const controller = new AbortController();
    void fetch(url, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw Error(String(response.status));
        return (await response.json()) as VoiceSettingsResponse;
      })
      .then((result) => {
        setSnapshot({ threadId: scopeKey, data: result });
        setFailure(null);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setFailure({ threadId: scopeKey, message: String(reason) });
      });
    return () => controller.abort();
  }, [threadId, environmentId, scopeKey]);

  const persist = useCallback(
    async (patch: VoiceSettingsPatch) => {
      const url = threadId ? voiceSettingsUrl(threadId, environmentId) : null;
      if (!url || !data || !threadId) return;
      const optimisticConfig = mergeConfig(data.config ?? DEFAULT_CONFIG, patch);
      setSnapshot((current) =>
        current?.threadId === scopeKey
          ? { ...current, data: { ...current.data, config: optimisticConfig } }
          : current,
      );
      setSavingThreadId(scopeKey);
      setFailure(null);
      try {
        const response = await fetch(url, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!response.ok) throw Error(String(response.status));
        const result = (await response.json()) as Partial<VoiceSettingsResponse>;
        const savedConfig = result.config ?? optimisticConfig;
        setSnapshot((current) =>
          current?.threadId === scopeKey
            ? {
                threadId: scopeKey,
                data: {
                  ...current.data,
                  ...result,
                  config: savedConfig,
                },
              }
            : current,
        );
        window.dispatchEvent(
          new CustomEvent("t3-voice-settings-changed", {
            detail: { threadId, config: savedConfig },
          }),
        );
        setDraft(null);
      } catch (reason) {
        setSnapshot((current) =>
          current?.threadId === scopeKey
            ? { ...current, data: { ...current.data, config: data.config } }
            : current,
        );
        setFailure({
          threadId: scopeKey,
          message: `Could not save voice settings (${String(reason)}).`,
        });
        throw reason;
      } finally {
        setSavingThreadId((current) => (current === scopeKey ? null : current));
      }
    },
    [data, threadId, environmentId, scopeKey],
  );

  const update = async (patch: VoiceSettingsPatch) => {
    if (deferred)
      setDraft((current) => mergeConfig(current ?? data?.config ?? DEFAULT_CONFIG, patch));
    else await persist(patch).catch(() => {});
  };
  return {
    data: data && draft ? { ...data, config: draft } : data,
    error,
    saving,
    update,
    changed: draft !== null && JSON.stringify(draft) !== JSON.stringify(data?.config),
    save: async () => {
      if (draft)
        await persist(
          threadId === "__global__"
            ? {
                modelSelection: draft.modelSelection,
                autoCallback: draft.autoCallback,
                instructions: { global: draft.instructions.global },
                terms: draft.terms,
              }
            : {
                modelSelection: draft.modelSelection,
                instructions: draft.instructions,
                enabledSkills: draft.enabledSkills,
                terms: draft.terms,
              },
        );
    },
    reset: () => setDraft(null),
  };
}

function ContextTextarea({
  label,
  description,
  value,
  onSave,
  deferred = false,
  readOnly = false,
}: {
  deferred?: boolean;
  label: string;
  description: string;
  value: string;
  onSave: (value: string) => void;
  readOnly?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <p className="text-xs leading-4 text-muted-foreground">{description}</p>
      {readOnly ? (
        <p className="whitespace-pre-wrap rounded-md border border-border/60 bg-muted/50 px-3 py-2 text-sm leading-5">
          {value || "—"}
        </p>
      ) : (
        <Textarea
          key={deferred ? "draft" : value}
          {...(deferred
            ? {
                value,
                onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) =>
                  onSave(event.target.value),
              }
            : { defaultValue: value })}
          rows={3}
          size="sm"
          onBlur={(event) => {
            const next = event.currentTarget.value.trim();
            if (!deferred && next !== value) onSave(next);
          }}
        />
      )}
    </div>
  );
}

/** Thread-scoped controls that configure the voice gateway without replacing T3's chat UI. */
export function VoiceSettingsPanel({
  threadId,
  open = false,
  onOpenChange,
  global = false,
  directControls,
  controller,
  environmentId,
}: {
  threadId: string | null | undefined;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  global?: boolean;
  directControls?: ReactNode;
  environmentId?: string | undefined;
  controller?: ReturnType<typeof useVoiceSettings>;
}) {
  const settings = usePrimarySettings();
  const localController = useVoiceSettings(
    controller ? null : global ? "__global__" : threadId,
    false,
    environmentId,
  );
  const { data, error, saving, update } = controller ?? localController;
  const config = data?.config ?? DEFAULT_CONFIG;
  const providers = data?.catalog.providers ?? [];
  const capabilities = data?.catalog.capabilities ?? [];
  const capabilityByInstance = useMemo(
    () => new Map(capabilities.map((capability) => [capability.instanceId, capability])),
    [capabilities],
  );
  const providerEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings, null),
      ),
    [providers, settings],
  );
  const defaultSelection = useMemo(
    () =>
      resolveDefaultProviderModelSelection(
        providers.filter(
          (provider) => capabilityByInstance.get(provider.instanceId)?.supported !== false,
        ),
        null,
      ),
    [capabilityByInstance, providers],
  );
  const activeSelection = useMemo(
    () =>
      resolveDefaultProviderModelSelection(providers, config.modelSelection) ?? defaultSelection,
    [config.modelSelection, defaultSelection, providers],
  );
  const modelOptionsByInstance = useMemo(
    () =>
      getCustomModelOptionsByInstance(
        settings,
        providers,
        activeSelection?.instanceId,
        activeSelection?.model,
      ),
    [activeSelection?.instanceId, activeSelection?.model, providers, settings],
  );
  const dedicatedModelEnabled = config.modelSelection !== null;
  const omittedSkillById = useMemo(
    () => new Map(data?.context.omittedSkills.map((skill) => [skill.id, skill]) ?? []),
    [data?.context.omittedSkills],
  );
  const hasTruncatedAgent = data?.context.agents.some((agent) => agent.truncated) ?? false;

  if (!threadId && !global) return null;

  return (
    <details
      open={open}
      className="group mt-1 border-t border-border/60 pt-0.5"
      onToggle={(event) => onOpenChange?.(event.currentTarget.open)}
    >
      <summary className="flex min-h-7 cursor-pointer list-none items-center justify-between -mx-1 px-1 gap-2 text-[11px] font-medium text-muted-foreground marker:hidden">
        <span>{global ? "Conversation model and instructions" : "Voice settings"}</span>
        <ChevronDownIcon className="size-3 text-muted-foreground transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none" />
      </summary>
      <div className="space-y-5 pt-3 pb-1">
        {!data && !error ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircleIcon className="size-4 animate-spin motion-reduce:animate-none" />
            Loading voice settings…
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {data ? (
          <>
            {global ? (
              <section className="space-y-2 border-t border-border/60 pt-4">
                <Label>
                  <Checkbox
                    checked={config.autoCallback}
                    disabled={saving}
                    onCheckedChange={(checked) => void update({ autoCallback: checked === true })}
                  />
                  Oddzwaniaj automatycznie po zakończeniu zadania
                </Label>
                <p className="text-xs leading-5 text-muted-foreground">
                  Gdy rozłączysz rozmowę, agent zadzwoni na zarejestrowany telefon z Androidem,
                  kiedy zadanie zlecone głosowo będzie gotowe. Wymaga włączonych powiadomień o
                  połączeniach w aplikacji. Podczas rozmowy wynik usłyszysz na bieżąco.
                </p>
              </section>
            ) : null}
            <section
              aria-labelledby="voice-model-heading"
              className="space-y-3 border-t border-border/60 pt-4"
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 id="voice-model-heading" className="text-sm font-medium">
                    Conversation model
                  </h3>
                  <p className="mt-1 text-xs leading-4 text-muted-foreground">
                    {global
                      ? "Choose the provider and model for new voice calls."
                      : "Model and Custom API are managed in Settings → Voice."}
                  </p>
                </div>
                {global ? (
                  <Select
                    value={config.modelSelection?.instanceId ?? "direct"}
                    disabled={saving}
                    onValueChange={(selected) => {
                      if (typeof selected !== "string") return;
                      const model = resolveDefaultProviderModelSelection(
                        providers.filter((p) => p.instanceId === selected),
                        null,
                      );
                      if (selected === "direct" || model)
                        void update({ modelSelection: selected === "direct" ? null : model });
                    }}
                  >
                    <SelectTrigger aria-label="Conversation provider" className="w-auto min-w-40">
                      <SelectValue>
                        {config.modelSelection
                          ? providers.find(
                              (p) => p.instanceId === config.modelSelection?.instanceId,
                            )?.displayName || config.modelSelection.instanceId
                          : "Custom API"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="end" alignItemWithTrigger={false}>
                      <SelectItem value="direct">Custom API</SelectItem>
                      {providers.map((provider) => (
                        <SelectItem
                          key={provider.instanceId}
                          value={provider.instanceId}
                          disabled={
                            capabilityByInstance.get(provider.instanceId)?.supported === false
                          }
                        >
                          {provider.displayName || provider.driver}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                ) : (
                  <span className="shrink-0 text-right text-sm">
                    {config.modelSelection
                      ? providers.find((p) => p.instanceId === config.modelSelection?.instanceId)
                          ?.displayName || config.modelSelection.instanceId
                      : "Custom API"}
                    <span className="block text-xs text-muted-foreground">
                      {activeSelection?.model}
                    </span>
                  </span>
                )}
              </div>
              {global && dedicatedModelEnabled && activeSelection ? (
                <ProviderModelPicker
                  environmentId={environmentId ? EnvironmentId.make(environmentId) : null}
                  activeInstanceId={activeSelection.instanceId}
                  model={activeSelection.model}
                  lockedProvider={null}
                  instanceEntries={providerEntries}
                  modelOptionsByInstance={modelOptionsByInstance}
                  triggerAriaLabel="Voice conversation model"
                  getModelDisabledReason={(instanceId) => {
                    const capability = capabilityByInstance.get(instanceId);
                    return capability?.supported === false
                      ? capability.reason || "This provider does not support voice inference."
                      : null;
                  }}
                  onInstanceModelChange={(instanceId: ProviderInstanceId, model) =>
                    update({ modelSelection: createModelSelection(instanceId, model) })
                  }
                />
              ) : (
                (directControls ?? null)
              )}
              <p className="text-xs leading-5 text-muted-foreground">
                {providers.find((p) => p.instanceId === config.modelSelection?.instanceId)
                  ?.driver === "codex"
                  ? "Reasoning defaults to Low for voice conversations."
                  : "Reasoning follows the selected provider or API defaults."}
              </p>
            </section>

            <section
              aria-labelledby="voice-context-heading"
              className="space-y-4 border-t border-border/60 pt-4"
            >
              <div>
                <h3 id="voice-context-heading" className="text-sm font-medium">
                  Conversation context
                </h3>
                <p className="mt-1 text-xs leading-4 text-muted-foreground">
                  Instructions apply to the next voice call.
                </p>
              </div>
              <ContextTextarea
                deferred={Boolean(controller)}
                label="Global instructions"
                description={
                  global ? "Applies to all projects." : "Edit in Settings → Voice for every call."
                }
                value={config.instructions.global}
                onSave={(value) => update({ instructions: { global: value } })}
                readOnly={!global}
              />
              {!global ? (
                <>
                  <ContextTextarea
                    label="Project instructions"
                    description="Applies to this project."
                    value={config.instructions.project}
                    onSave={(project) => update({ instructions: { project } })}
                  />
                  <ContextTextarea
                    label="Thread instructions"
                    description="Applies to this thread."
                    value={config.instructions.thread}
                    onSave={(thread) => update({ instructions: { thread } })}
                  />
                  <div className="space-y-2">
                    <Label>Project and user skills</Label>
                    {data.context.skills.length ? (
                      <div className="space-y-2">
                        {data.context.skills.map((skill) => {
                          const enabled = config.enabledSkills.includes(skill.id);
                          const omitted = omittedSkillById.get(skill.id);
                          return (
                            <label
                              key={skill.id}
                              className="flex cursor-pointer items-start gap-2 text-sm"
                            >
                              <Checkbox
                                checked={enabled}
                                onCheckedChange={(checked) =>
                                  update({
                                    enabledSkills: checked
                                      ? [...config.enabledSkills, skill.id]
                                      : config.enabledSkills.filter((id) => id !== skill.id),
                                  })
                                }
                              />
                              <span className="min-w-0">
                                <span className="block">{skill.name}</span>
                                <span className="block truncate text-xs text-muted-foreground">
                                  {skill.path}
                                </span>
                                {omitted ? (
                                  <span className="mt-1 block text-xs leading-4 text-amber-700 dark:text-amber-300">
                                    Omitted: {omitted.reason}
                                  </span>
                                ) : null}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        No project or user skills found.
                      </p>
                    )}
                  </div>
                  <details className="rounded-lg bg-muted/45 px-3 py-2">
                    <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium">
                      <span>Loaded instructions and AGENTS.md</span>
                      {hasTruncatedAgent ? (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
                          Truncated
                        </span>
                      ) : null}
                    </summary>
                    <pre
                      className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-5 text-muted-foreground"
                      tabIndex={0}
                    >
                      {data.context.effectiveInstructions ||
                        data.context.agents
                          .map((agent) => `${agent.path}\n${agent.content}`)
                          .join("\n\n") ||
                        "No instructions loaded."}
                    </pre>
                  </details>
                </>
              ) : null}
            </section>
          </>
        ) : null}
        {saving ? <p className="text-xs text-muted-foreground">Saving…</p> : null}
      </div>
    </details>
  );
}
