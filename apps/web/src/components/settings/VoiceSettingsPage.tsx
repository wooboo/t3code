import { useEffect, useState } from "react";
import type { VoiceAgentSettings, VoiceAgentSettingsSnapshot } from "@t3tools/contracts";
import { VoiceSettingsPanel, useVoiceSettings } from "../chat/VoiceSettingsPanel";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { VoiceExecutionTargets } from "./VoiceExecutionTargets";
import { VoiceSettingsSelect } from "./VoiceSettingsSelect";
import { Label } from "../ui/label";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { PlusIcon, Trash2Icon } from "lucide-react";

/** Term replacements apply to future speech-to-text output; each row rewrites a phrase. */
function TermRows({
  terms,
  disabled,
  onChange,
}: {
  terms: Array<{ from: string; to: string }>;
  disabled: boolean;
  onChange: (terms: Array<{ from: string; to: string }>) => void;
}) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const add = () => {
    if (!from.trim() || !to.trim()) return;
    if (from.trim().toLowerCase() === to.trim().toLowerCase()) return;
    if (terms.some((t) => t.from.toLowerCase() === from.trim().toLowerCase()))
      onChange(
        terms.map((t) =>
          t.from.toLowerCase() === from.trim().toLowerCase()
            ? { from: from.trim(), to: to.trim() }
            : t,
        ),
      );
    else onChange([...terms, { from: from.trim(), to: to.trim() }]);
    setFrom("");
    setTo("");
  };
  return (
    <div className="space-y-2">
      {terms.length ? (
        <ul className="space-y-2">
          {terms.map((term) => (
            <li key={term.from.toLowerCase()} className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate rounded-md bg-muted/50 px-2 py-1.5 text-xs">
                {term.from}
              </span>
              <span aria-hidden>→</span>
              <span className="min-w-0 flex-1 truncate rounded-md bg-muted/50 px-2 py-1.5 text-xs">
                {term.to}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={disabled}
                aria-label={`Remove ${term.from}`}
                onClick={() => onChange(terms.filter((t) => t.from !== term.from))}
              >
                <Trash2Icon />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">
          No corrections yet. Pick a word in a call transcript to add one.
        </p>
      )}
      <div className="flex items-center gap-2">
        <Input
          value={from}
          disabled={disabled}
          placeholder="Transcribed as…"
          aria-label="Transcribed form"
          onChange={(e) => setFrom(e.target.value)}
        />
        <span aria-hidden>→</span>
        <Input
          value={to}
          disabled={disabled}
          aria-label="Correct form"
          placeholder="Correct form"
          onChange={(e) => setTo(e.target.value)}
        />
        <Button type="button" variant="ghost" size="icon-sm" disabled={disabled} onClick={add}>
          <PlusIcon />
        </Button>
      </div>
    </div>
  );
}

const endpoint = () =>
  new URL(
    "agent-settings",
    new URL(import.meta.env.VITE_VOICE_FRONT_ORIGIN || "/voice/", window.location.origin),
  );

export function VoiceSettingsPage() {
  const conversation = useVoiceSettings("__global__", true);
  const [snapshot, setSnapshot] = useState<VoiceAgentSettingsSnapshot | null>(null);
  const [draft, setDraft] = useState<VoiceAgentSettings | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [llmKey, setLlmKey] = useState<string | undefined>();
  useEffect(() => {
    const controller = new AbortController();
    void fetch(endpoint(), { signal: controller.signal })
      .then(async (r) => {
        if (!r.ok) throw Error("Service configuration requires an environment running LiveKit.");
        const data = (await r.json()) as VoiceAgentSettingsSnapshot;
        setSnapshot(data);
        setDraft(data.config);
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setError(String(e));
      });
    return () => controller.abort();
  }, []);
  const servicesChanged =
    JSON.stringify(draft) !== JSON.stringify(snapshot?.config ?? null) || llmKey !== undefined;
  const changed = servicesChanged || conversation.changed;
  function change<K extends keyof VoiceAgentSettings>(key: K, value: VoiceAgentSettings[K]) {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
    setMessage("");
  }
  const textField = (
    key: "ttsUrl" | "ttsModel" | "ttsVoice" | "sttUrl" | "sttModel" | "llmUrl" | "llmModel",
    label: string,
    help?: string,
    disabled = false,
  ) => (
    <div className="space-y-1.5" key={key}>
      <Label htmlFor={`voice-${key}`}>{label}</Label>
      <Input
        id={`voice-${key}`}
        value={draft?.[key] ?? ""}
        disabled={disabled || busy}
        onChange={(e) => change(key, e.target.value)}
      />
      {help ? <p className="text-xs leading-5 text-muted-foreground">{help}</p> : null}
    </div>
  );
  async function save() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      let restartRequired = snapshot?.restartRequired ?? false;
      if (servicesChanged) {
        const r = await fetch(endpoint(), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...draft, ...(llmKey !== undefined ? { llmKey } : {}) }),
        });
        const data = (await r.json()) as VoiceAgentSettingsSnapshot & { error?: string };
        if (!r.ok) throw Error(data.error || "Could not save settings.");
        restartRequired = data.restartRequired;
        setSnapshot(data);
        setDraft(data.config);
        setLlmKey(undefined);
      }
      await conversation.save();
      if (restartRequired) {
        const r = await fetch(`${endpoint().href}/apply`, { method: "POST" });
        if (!r.ok) throw Error("Settings saved, but restart failed. Try Save and apply again.");
        setMessage(
          "Settings saved. The voice environment is restarting; reconnect to start a new call.",
        );
      } else setMessage("Settings saved. They will be used for the next voice call.");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <SettingsPageContainer>
      <SettingsSection id="voice" title="Voice" variant="plain">
        <div className="max-w-2xl space-y-6">
          <p className="text-sm text-muted-foreground">
            Configure the LiveKit voice agent for this environment. Project and thread instructions
            are available beside the conversation.
          </p>
          <VoiceExecutionTargets />
          <VoiceSettingsPanel
            threadId={null}
            global
            controller={conversation}
            open
            directControls={
              draft ? (
                <div className="space-y-3">
                  {textField("llmModel", "Model ID")}
                  {textField(
                    "llmUrl",
                    "API URL",
                    "Leave empty to use the server’s default endpoint and credentials.",
                  )}
                  <div className="space-y-1.5">
                    <Label htmlFor="voice-api-type">API type</Label>
                    <VoiceSettingsSelect
                      id="voice-api-type"
                      value={draft.llmApiType}
                      disabled={busy}
                      onValueChange={(value) =>
                        change("llmApiType", value as VoiceAgentSettings["llmApiType"])
                      }
                      options={[
                        { value: "responses", label: "OpenAI Responses" },
                        { value: "chat-completions", label: "OpenAI Chat Completions" },
                      ]}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="voice-api-key">API key</Label>
                    <Input
                      id="voice-api-key"
                      type="password"
                      autoComplete="new-password"
                      value={llmKey ?? ""}
                      disabled={busy}
                      placeholder={
                        snapshot?.llmKeyConfigured
                          ? "Saved on server · enter to replace"
                          : "Optional for local servers"
                      }
                      onChange={(e) => setLlmKey(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      Stored on the server and never returned to clients.
                    </p>
                    {snapshot?.llmKeyConfigured ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => setLlmKey("")}
                      >
                        Remove saved key
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : null
            }
          />
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {!draft && !error ? (
            <p role="status" className="text-sm">
              Loading configuration…
            </p>
          ) : null}
          {draft ? (
            <fieldset disabled={busy} className="space-y-6 disabled:opacity-60">
              <section
                className="space-y-3 border-t border-border/60 pt-5"
                aria-labelledby="voice-stt-heading"
              >
                <h3 id="voice-stt-heading" className="text-sm font-medium">
                  Speech recognition
                </h3>
                {textField("sttModel", "Model STT")}
                {textField(
                  "sttUrl",
                  "Transcription API URL",
                  "Defaults to local Parakeet on Minion. Custom servers must provide a compatible transcription API.",
                )}
                <p className="text-xs text-muted-foreground">
                  Language follows the user’s speech. Transcripts go directly to the agent without a
                  cleanup model.
                </p>
              </section>
              <section
                className="space-y-3 border-t border-border/60 pt-5"
                aria-labelledby="voice-tts-heading"
              >
                <h3 id="voice-tts-heading" className="text-sm font-medium">
                  Speech synthesis and voice
                </h3>
                <Label htmlFor="voice-ttsProvider">TTS provider</Label>
                <VoiceSettingsSelect
                  id="voice-ttsProvider"
                  value={draft.ttsProvider}
                  onValueChange={(value) => {
                    const provider = value as VoiceAgentSettings["ttsProvider"];
                    setDraft((c) =>
                      !c
                        ? c
                        : provider === "custom"
                          ? { ...c, ttsProvider: provider }
                          : {
                              ...c,
                              ttsProvider: provider,
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
                            },
                    );
                  }}
                  options={[
                    { value: "elevenlabs", label: "ElevenLabs · cloud" },
                    { value: "breeze", label: "Breeze TTS 2 · local" },
                    { value: "custom", label: "Custom TTS server" },
                  ]}
                />
                {textField("ttsModel", "Model TTS", undefined, draft.ttsProvider === "breeze")}
                {textField(
                  "ttsVoice",
                  "Voice / Voice ID",
                  "Uses the same voice for every response.",
                  draft.ttsProvider === "breeze",
                )}
                {textField("ttsUrl", "Speech API URL", undefined, draft.ttsProvider !== "custom")}
                <div className="space-y-1.5">
                  <Label htmlFor="voice-rate">PCM sample rate</Label>
                  <VoiceSettingsSelect
                    id="voice-rate"
                    value={String(draft.ttsSampleRate)}
                    disabled={draft.ttsProvider !== "custom"}
                    onValueChange={(value) =>
                      change("ttsSampleRate", Number(value) as VoiceAgentSettings["ttsSampleRate"])
                    }
                    options={[16000, 22050, 24000, 44100, 48000].map((rate) => ({
                      value: String(rate),
                      label: `${rate} Hz`,
                    }))}
                  />
                </div>
                <p className="text-xs leading-5 text-muted-foreground">
                  {draft.ttsProvider === "elevenlabs"
                    ? "Uses the ElevenLabs key stored on Minion."
                    : draft.ttsProvider === "breeze"
                      ? "Requires the local Breeze service. Polish is experimental; generation may be slower than playback."
                      : "Requires an audio/speech API returning raw 16-bit mono PCM. Configure any required API key on the server."}
                </p>
              </section>
              <section
                className="space-y-3 border-t border-border/60 pt-5"
                aria-labelledby="voice-livekit-heading"
              >
                <h3 id="voice-livekit-heading" className="text-sm font-medium">
                  LiveKit turn handling
                </h3>
                <div className="space-y-1.5">
                  <Label htmlFor="voice-silence">End-of-speech silence (ms)</Label>
                  <Input
                    id="voice-silence"
                    type="number"
                    min={200}
                    max={2000}
                    step={50}
                    value={draft.silenceMs}
                    onChange={(e) => change("silenceMs", e.currentTarget.valueAsNumber)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Shorter silence improves responsiveness but may split speech at natural pauses.
                  </p>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={draft.interruptions}
                    onChange={(e) => change("interruptions", e.target.checked)}
                  />
                  Interrupt the agent when I speak
                </label>
                <p className="text-xs leading-5 text-muted-foreground">
                  Applies to all new voice calls.
                </p>
              </section>
              {conversation.data ? (
                <section
                  className="space-y-3 border-t border-border/60 pt-5"
                  aria-labelledby="voice-terms-heading"
                >
                  <h3 id="voice-terms-heading" className="text-sm font-medium">
                    Transcript corrections
                  </h3>
                  <p className="text-xs leading-5 text-muted-foreground">
                    Rewrites misconverted words in every future transcription, before the agent
                    reads them. Applies to the next voice call without touching the live one.
                  </p>
                  <TermRows
                    terms={conversation.data.config.terms}
                    disabled={busy}
                    onChange={(terms) => void conversation.update({ terms })}
                  />
                </section>
              ) : null}
              <div className="space-y-3 border-t border-border/60 pt-5">
                <div className="flex flex-wrap gap-2">
                  <Button
                    disabled={(!changed && !snapshot?.restartRequired) || busy}
                    onClick={() => void save()}
                  >
                    Save and apply
                  </Button>

                  <Button
                    variant="ghost"
                    disabled={!changed || busy}
                    onClick={() => {
                      conversation.reset();
                      setDraft(snapshot?.config ?? null);
                      setLlmKey(undefined);
                      setError("");
                    }}
                  >
                    Discard changes
                  </Button>
                </div>
                <p className="text-xs leading-5 text-muted-foreground">
                  Changes apply to the next voice call. Service changes automatically restart this
                  environment, ending active calls and briefly disconnecting clients.
                </p>
                {snapshot?.restartRequired ? (
                  <p className="text-sm">Saved configuration is waiting for a restart.</p>
                ) : null}
              </div>
            </fieldset>
          ) : null}
          {message ? (
            <p role="status" className="text-sm">
              {message}
            </p>
          ) : null}
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
