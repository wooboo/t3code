import { applyTermReplacements, groupVoiceTranscript } from "@t3tools/client-runtime/voice-input";
import {
  ActivityIcon,
  ChevronDownIcon,
  MicIcon,
  MicOffIcon,
  PhoneOffIcon,
  SquarePenIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { useVoiceSettings } from "./VoiceSettingsPanel";
import {
  averageLatency,
  formatCallClock,
  formatCallDuration,
  formatLatency,
  summarizePipelineStats,
  type useVoiceFront,
} from "./useVoiceFront";
import { VoiceSettingsPanel } from "./VoiceSettingsPanel";

/**
 * Live duration for the running call. Re-renders at most once per second and
 * only this element; the transcript above it must not rerender on the timer.
 */
function CallDuration({ startedAt, endedAt }: { startedAt?: number; endedAt: number | undefined }) {
  const [, tick] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    if (!startedAt || endedAt) return;
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [startedAt, endedAt]);
  if (!startedAt) return null;
  return <>{formatCallDuration((endedAt ?? Date.now()) - startedAt)}</>;
}

/** Local integration pilot. The gateway binds this T3 thread before loading audio. */
export type Voice = ReturnType<typeof useVoiceFront>;

export function VoiceButton({ voice, onOpenPanel }: { voice: Voice; onOpenPanel: () => void }) {
  if (!voice.enabled) return null;
  return (
    <div className="flex shrink-0 items-center">
      <Button
        type="button"
        size="icon-sm"
        variant={voice.active ? "secondary" : "ghost"}
        className="size-11 shrink-0 sm:size-8"
        aria-pressed={voice.active}
        aria-label={voice.active ? "End voice call" : "Start voice call"}
        title={voice.active ? "End voice call" : "Voice call"}
        onClick={() => {
          if (voice.active) voice.stop();
          else {
            void voice.start();
            onOpenPanel();
          }
        }}
      >
        <MicIcon />
      </Button>
      {voice.active || voice.error ? (
        <span
          className="max-w-16 truncate px-1 text-xs text-muted-foreground sm:max-w-28"
          role="status"
          aria-label={voice.error || (voice.muted ? "Microphone muted" : voice.status)}
        >
          {voice.error ? "Voice error" : voice.muted ? "Muted" : voice.status || "Connected"}
        </span>
      ) : null}
    </div>
  );
}

/** Selected text inside the clicked bubble becomes the replacement key. */
function getSelectionOver(element: HTMLElement) {
  if (!window.getSelection) return null;
  const selection = window.getSelection();
  if (!selection?.anchorNode || !element.contains(selection.anchorNode)) return null;
  return selection.toString();
}

export function VoicePanel({
  voice,
  threadId,
  environmentId,
}: {
  voice: Voice;
  threadId?: string | null;
  environmentId?: string | undefined;
}) {
  const globalSettings = useVoiceSettings("__global__", false, environmentId);
  const { refreshHistory } = voice;
  useEffect(() => {
    refreshHistory();
  }, [refreshHistory]);
  const termsData = globalSettings.data;
  const terms = useMemo(() => termsData?.config.terms ?? [], [termsData]);
  const transcript = useMemo(
    () =>
      groupVoiceTranscript(
        voice.transcript.map((entry) =>
          entry.role === "user"
            ? { ...entry, content: applyTermReplacements(entry.content, terms) }
            : entry,
        ),
      ),
    // Terms feed raw entries with the latest correction map.
    [voice.transcript, terms],
  );
  const [fix, setFix] = useState<{ from: string; to: string } | null>(null);
  const [showStats, setShowStats] = useState(false);
  const [fixPoint, setFixPoint] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const fixEditor = useRef<HTMLDivElement>(null);
  const [fixBusy, setFixBusy] = useState(false);
  // Selection-based flow: finishing a drag reveals a small icon beside the selection;
  // opening the editor keeps its anchor under the selection, never over the bubble.
  const openEditorFor = (rect: DOMRect, viewportWidth?: number) => {
    const width = viewportWidth ?? window.innerWidth;
    const height = window.innerHeight;
    const editorHeight = 200;
    setFixPoint({
      x: Math.max(8, Math.min(rect.left, width - 340)),
      y:
        rect.bottom + 8 + editorHeight <= height
          ? rect.bottom + 8
          : Math.max(8, rect.top - editorHeight - 8),
    });
    setFix({ from: (window.getSelection()?.toString() || "").trim(), to: "" });
  };
  const [fixIntent, setFixIntent] = useState<{
    from: string;
    icon: { x: number; y: number };
    rect: DOMRect;
  } | null>(null);
  useEffect(() => {
    if (typeof document === "undefined") return;
    const applySelection = () => {
      const selection = window.getSelection();
      if (!selection?.anchorNode || selection.isCollapsed || !selection.rangeCount) {
        setFixIntent(null);
        return;
      }
      const bubble = selection.anchorNode.parentElement?.closest?.("div[data-replace]");
      if (!(bubble instanceof HTMLElement)) return;
      const text = selection.toString().trim();
      if (!text) return;
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      setFixIntent({
        from: text,
        icon: { x: Math.min(rect.right + 4, window.innerWidth - 36), y: rect.bottom + 4 },
        rect,
      });
    };
    document.addEventListener("selectionchange", applySelection);
    return () => document.removeEventListener("selectionchange", applySelection);
  }, []);
  // Clicking outside the editor (or its icon) closes both, like a popover.
  useEffect(() => {
    if ((!fix && !fixIntent) || typeof document === "undefined") return;
    const dismiss = (event: MouseEvent) => {
      const target = event.target as Node;
      if (fixEditor.current?.contains(target)) return;
      if ((target as HTMLElement).closest?.("[data-fix-intent]")) return;
      setFix(null);
      setFixIntent(null);
    };
    document.addEventListener("mousedown", dismiss);
    return () => document.removeEventListener("mousedown", dismiss);
  }, [fix, fixIntent]);
  async function saveFix() {
    if (!fix || fixBusy) return;
    setFixBusy(true);
    try {
      const from = fix.from.trim();
      const to = fix.to.trim();
      if (!from || !to || from.toLowerCase() === to.toLowerCase()) return;
      await globalSettings.update({
        terms: [...terms.filter((t) => t.from.toLowerCase() !== from.toLowerCase()), { from, to }],
      });
      setFix(null);
    } finally {
      setFixBusy(false);
    }
  }
  const avgTranscription = useMemo(
    () => averageLatency(voice.latency?.transcription ?? []),
    [voice.latency],
  );
  const avgResponse = useMemo(
    () => averageLatency(voice.latency?.responses ?? []),
    [voice.latency],
  );
  const latestMessage = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!voice.enabled || transcript.length === 0) return;
    latestMessage.current?.scrollIntoView({ block: "end", behavior: "instant" });
  }, [transcript, voice.enabled]);
  if (!voice.enabled) return <p className="p-3 text-sm">Voice is unavailable in this thread.</p>;
  return (
    <section
      aria-label="Voice call"
      className="flex h-full min-h-0 min-w-0 flex-col px-2 py-3 text-sm text-foreground"
    >
      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {transcript.length === 0 ? (
          <p className="px-4 py-10 text-center leading-relaxed text-muted-foreground">
            {voice.active
              ? "Your conversation will appear here."
              : "Start a call to talk to the agent."}
          </p>
        ) : null}
        {transcript.length > 0 && (
          <div>
            <div className="space-y-4 py-2">
              {transcript.map((entry, index) => (
                <div
                  key={entry.id}
                  ref={index === transcript.length - 1 ? latestMessage : undefined}
                  className={`w-fit min-w-0 max-w-[90%] sm:max-w-[85%] ${entry.role === "user" ? "ml-auto" : "mr-auto"}`}
                >
                  <p
                    className={`mb-1 px-3 text-xs text-muted-foreground ${entry.role === "user" ? "text-right" : "text-left"}`}
                  >
                    {entry.role === "user" ? "You" : "Voice"}
                  </p>
                  {entry.role === "user" ? (
                    // A real `button` refuses text selection (UA user-select:none), which
                    // breaks word-selection fixes; a focusable div keeps both behaviors.
                    <div
                      role="button"
                      tabIndex={0}
                      data-replace
                      className="block w-full cursor-pointer select-text text-left whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-primary px-4 py-3 leading-relaxed text-primary-foreground [overflow-wrap:anywhere]"
                      title="Fix a misconverted phrase in every future transcription"
                      onClick={(event) => {
                        const selection = getSelectionOver(event.currentTarget);
                        if (selection?.trim()) return;
                        // Whole-utterance fallback anchored below the bubble, not over it.
                        const rect = event.currentTarget.getBoundingClientRect();
                        const editorHeight = 200;
                        setFixPoint({
                          x: Math.max(8, Math.min(rect.left, window.innerWidth - 340)),
                          y:
                            rect.bottom + 8 + editorHeight <= window.innerHeight
                              ? rect.bottom + 8
                              : Math.max(8, rect.top - editorHeight - 8),
                        });
                        const text = event.currentTarget.textContent?.trim();
                        if (text) setFix({ from: text, to: "" });
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          const text = event.currentTarget.textContent?.trim();
                          if (text) setFix({ from: text, to: "" });
                        }
                      }}
                    >
                      {entry.content}
                    </div>
                  ) : (
                    <div className="whitespace-pre-wrap break-words rounded-2xl rounded-bl-md bg-muted px-4 py-3 leading-relaxed text-foreground [overflow-wrap:anywhere]">
                      {entry.content}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
        {fixIntent && !fix ? (
          <button
            type="button"
            data-fix-intent
            aria-label="Fix transcription"
            title="Fix transcription"
            className="fixed z-50 flex size-7 items-center justify-center rounded-full border border-border bg-background text-foreground shadow-md"
            style={{ left: fixIntent.icon.x, top: fixIntent.icon.y }}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => {
              const intent = fixIntent;
              setFixIntent(null);
              openEditorFor(intent.rect, window.innerWidth);
              setFix({ from: intent.from, to: "" });
            }}
          >
            <SquarePenIcon className="size-3.5" />
          </button>
        ) : null}
        {fix ? (
          <div
            ref={fixEditor}
            aria-label="Transcription correction"
            role="dialog"
            className="fixed z-50 w-80 space-y-2 rounded-lg border border-border bg-background p-3 shadow-lg"
            style={{ left: fixPoint.x, top: fixPoint.y }}
          >
            <p className="text-xs text-muted-foreground">
              Replace transcribed text with the correct form; applies to every future call.
            </p>
            <div className="flex items-center gap-2">
              <Input
                value={fix.from}
                disabled={fixBusy}
                aria-label="Transcribed form"
                onChange={(e) => setFix({ ...fix, from: e.target.value })}
              />
              <span aria-hidden>→</span>
              <Input
                value={fix.to}
                disabled={fixBusy}
                aria-label="Correct form"
                placeholder="Correct form"
                onChange={(e) => setFix({ ...fix, to: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void saveFix();
                }}
              />
            </div>
            <div className="flex gap-2">
              <Button type="button" size="sm" disabled={fixBusy} onClick={() => void saveFix()}>
                Fix text
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={fixBusy}
                onClick={() => setFix(null)}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : null}
      </div>
      {!voice.active && voice.startedAt ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Call ended at {formatCallClock(voice.startedAt)}–
          {voice.endedAt ? formatCallClock(voice.endedAt) : "now"} ·{" "}
          {formatCallDuration((voice.endedAt ?? Date.now()) - voice.startedAt)}
        </p>
      ) : null}
      <div className="mt-2 flex flex-col gap-1.5 border-t border-border pb-1 pt-2">
        {voice.error && (
          <p role="alert" className="text-destructive">
            {voice.error}
          </p>
        )}
        <div className="flex min-w-0 items-center gap-2">
          <span role="status" className="min-w-0 flex-1 truncate">
            {voice.muted ? "Microphone muted" : voice.status || "Ready for a voice call"}
          </span>
          {voice.startedAt ? (
            <span
              className="shrink-0 text-xs tabular-nums text-muted-foreground"
              aria-label={voice.active ? "Call duration" : "Call length"}
            >
              <CallDuration startedAt={voice.startedAt} endedAt={voice.endedAt} />
            </span>
          ) : null}
          <Button
            type="button"
            variant={showStats ? "secondary" : "ghost"}
            size="icon-sm"
            className="size-11 sm:size-8"
            aria-pressed={showStats}
            aria-label={showStats ? "Hide pipeline stats" : "Show pipeline stats"}
            onClick={() => setShowStats((open) => !open)}
          >
            <ActivityIcon />
          </Button>
          {voice.active ? (
            <>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="size-11 sm:size-8"
                aria-pressed={voice.muted}
                aria-label={voice.muted ? "Unmute microphone" : "Mute microphone"}
                onClick={voice.toggleMute}
              >
                {voice.muted ? <MicOffIcon /> : <MicIcon />}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="size-11 sm:size-8"
                aria-label="End call"
                onClick={voice.stop}
              >
                <PhoneOffIcon />
              </Button>
            </>
          ) : (
            <Button type="button" variant="secondary" size="sm" onClick={() => void voice.start()}>
              <MicIcon /> Start
            </Button>
          )}
        </div>
        {showStats ? (
          <dl
            aria-label="Pipeline stats"
            className="grid grid-cols-2 gap-x-4 gap-y-0.5 border-t border-border/60 pt-1.5 text-xs tabular-nums text-muted-foreground"
          >
            {summarizePipelineStats(voice.sdkMetrics ?? [], voice.latency?.responses ?? []).map(
              (stat) =>
                stat.ms !== null ? (
                  <div
                    key={stat.label}
                    className="flex min-w-0 items-baseline justify-between gap-2"
                  >
                    <dt className="min-w-0 truncate">{stat.label}</dt>
                    <dd className="shrink-0">
                      {stat.unit === "tok/s"
                        ? `${stat.ms.toFixed(1)} tok/s`
                        : formatLatency(stat.ms)}
                      <span className="ml-1 text-[10px] opacity-60">×{stat.samples}</span>
                    </dd>
                  </div>
                ) : null,
            )}
          </dl>
        ) : null}
        {showStats ? (
          <div className="space-y-1 border-t border-border/60 pt-1.5">
            <label className="block">
              <span className="text-xs text-muted-foreground">Microphone</span>
              <select
                className="mt-1 block w-full rounded-md border border-input bg-background p-2"
                value={voice.deviceId}
                disabled={voice.active}
                onChange={(e) => voice.setDeviceId(e.target.value)}
              >
                <option value="">Default system microphone</option>
                {voice.devices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || "Microphone"}
                  </option>
                ))}
              </select>
            </label>
            <p className="pb-1 text-xs">
              End the call to change microphones. Configure speech models and voice in Settings →
              Voice. Ending a call does not stop the coding task.
            </p>
            <VoiceSettingsPanel
              environmentId={environmentId}
              threadId={threadId}
              open={voice.settingsOpen}
              onOpenChange={(open) => {
                if (open !== voice.settingsOpen) voice.toggleSettings();
              }}
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}
