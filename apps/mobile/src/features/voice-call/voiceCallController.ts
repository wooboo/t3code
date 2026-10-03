export type VoiceMessage = {
  id: string;
  role: string;
  content: string;
};

export type VoiceCallState = {
  active: boolean;
  muted: boolean;
  status: string;
  error: string;
  messages: VoiceMessage[];
};

export type VoiceAudioRoute = "earpiece" | "speaker" | "bluetooth" | "headset" | "default";

export interface VoiceAudioPort {
  start(options: { inputSampleRate: number; outputSampleRate: number }): Promise<void>;
  stop(): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  setAudioRoute(route: VoiceAudioRoute): Promise<void>;
  enqueueAudio(packet: { pcmBase64: string; responseId: string }): Promise<void>;
  finishResponse(responseId: string): Promise<void>;
  clearPlayback(): Promise<void>;
  addListener(
    event: "pcm",
    listener: (event: { audio: string; level?: number }) => void,
  ): {
    remove(): void;
  };
  addListener(
    event: "playback",
    listener: (event: { type: string; responseId: string }) => void,
  ): { remove(): void };
  addListener(
    event: "state",
    listener: (event: { status: string; error?: string }) => void,
  ): { remove(): void };
  addListener(
    event: "route",
    listener: (event: { available: VoiceAudioRoute[]; selected?: VoiceAudioRoute }) => void,
  ): { remove(): void };
}

export interface VoiceSocket {
  readyState: number;
  bufferedAmount?: number;
  onopen: (() => void) | null;
  onmessage: ((message: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  send(data: string): void;
  close(): void;
}

export function voiceGatewayUrl(httpBaseUrl: string, route: string, threadId: string): URL {
  const base = new URL(httpBaseUrl);
  if (base.protocol !== "https:") throw Error("Voice call wymaga połączenia HTTPS.");
  const url = new URL(`voice/${route}`, base.href.endsWith("/") ? base : `${base.href}/`);
  url.searchParams.set("thread", threadId);
  return url;
}

/** One controller per mounted thread, independent of the voice sheet's visibility. */
export class VoiceCallController {
  state: VoiceCallState = {
    active: false,
    muted: false,
    status: "Ready for a call",
    error: "",
    messages: [],
  };
  private generation = 0;
  private socket: VoiceSocket | null = null;
  private abort: AbortController | null = null;
  private timeout: ReturnType<typeof setTimeout> | undefined;
  private subscriptions: Array<{ remove(): void }> = [];
  private suspended = false;
  private stopping: Promise<void> = Promise.resolve();

  constructor(
    private readonly deps: {
      baseUrl: string;
      threadId: string;
      bearerToken: string;
      audio: VoiceAudioPort;
      requestPermission(): Promise<boolean>;
      fetch: typeof fetch;
      connect(url: string, headers: Record<string, string>): VoiceSocket;
      onChange(state: VoiceCallState): void;
      onAudioLevel?(level: number): void;
      onAudioRoute?(available: VoiceAudioRoute[], selected?: VoiceAudioRoute): void;
    },
  ) {}

  private update(patch: Partial<VoiceCallState>) {
    this.state = { ...this.state, ...patch };
    this.deps.onChange(this.state);
  }

  private send(event: Record<string, unknown>) {
    if (this.socket?.readyState === 1) this.socket.send(JSON.stringify(event));
  }

  async request(route: string, init: RequestInit = {}) {
    const response = await this.deps.fetch(
      voiceGatewayUrl(this.deps.baseUrl, route, this.deps.threadId),
      {
        ...init,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.deps.bearerToken}`,
        },
      },
    );
    if (!response.ok)
      throw Error(
        response.status === 401
          ? "Połącz aplikację ponownie z T3."
          : "Gateway głosowy jest niedostępny dla tego serwera.",
      );
    return response.json();
  }

  async loadHistory(signal?: AbortSignal) {
    const data = await this.request("t3-history", { signal });
    if (!signal?.aborted && Array.isArray(data.messages)) {
      const current = this.state.messages;
      this.update({
        messages: [
          ...data.messages.filter((m: VoiceMessage) => !current.some((item) => item.id === m.id)),
          ...current,
        ].slice(-100),
      });
    }
  }

  async start() {
    if (this.state.active) return;
    const run = ++this.generation;
    this.update({ active: true, muted: false, error: "", status: "Connecting…" });
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.timeout = setTimeout(() => this.fail(run, "Przekroczono czas łączenia."), 30000);
    try {
      await this.stopping;
      if (run !== this.generation) return;
      if (!(await this.deps.requestPermission()))
        throw Error("Zezwól aplikacji na korzystanie z mikrofonu.");
      if (run !== this.generation) return;
      // JSON binding avoids native fetch redirect/cookie differences.
      const bindingUrl = voiceGatewayUrl(this.deps.baseUrl, "t3-connect", this.deps.threadId);
      bindingUrl.searchParams.set("format", "json");
      const response = await this.deps.fetch(bindingUrl, {
        signal,
        headers: { Authorization: `Bearer ${this.deps.bearerToken}` },
      });
      if (!response.ok) throw Error("Nie można połączyć z gatewayem głosowym. Sprawdź sesję T3.");
      const binding = await response.json();
      if (typeof binding.sessionId !== "string" || !binding.sessionId)
        throw Error("Gateway nie obsługuje połączeń mobilnych.");
      if (run !== this.generation) return;
      const socketUrl = voiceGatewayUrl(this.deps.baseUrl, "api/realtime", this.deps.threadId);
      socketUrl.protocol = "wss:";
      socketUrl.searchParams.set("sessionId", binding.sessionId);
      const socket = this.deps.connect(socketUrl.href, {
        Authorization: `Bearer ${this.deps.bearerToken}`,
      });
      this.socket = socket;
      this.suspended = false;
      this.subscriptions = [
        this.deps.audio.addListener("pcm", ({ audio, level }) => {
          this.deps.onAudioLevel?.(this.state.muted ? 0 : (level ?? 0));
          if (
            run === this.generation &&
            !this.state.muted &&
            !this.suspended &&
            // React Native declares this browser property but leaves it unset.
            (socket.bufferedAmount ?? 0) < 128000
          )
            this.send({ type: "audio.append", audio });
        }),
        this.deps.audio.addListener("playback", (event) => {
          if (run === this.generation)
            this.send({ type: event.type, responseId: event.responseId });
        }),
        this.deps.audio.addListener("state", (event) => {
          if (run !== this.generation) return;
          if (event.status === "stopped") this.stop();
          else if (event.status === "error" || event.status === "interrupted")
            this.fail(run, event.error || "Rozmowa została przerwana przez system.");
        }),
        this.deps.audio.addListener("route", (event) => {
          if (run === this.generation) this.deps.onAudioRoute?.(event.available, event.selected);
        }),
      ];
      socket.onopen = () =>
        this.send({
          type: "connect",
          clientType: "mobile",
          clientLabel: "T3 Android",
          inputEnabled: true,
          outputEnabled: true,
          voiceEnabled: true,
          locale: "pl-PL",
        });
      let events = Promise.resolve();
      let ready = false;
      socket.onmessage = ({ data }) => {
        events = events
          .then(async () => {
            if (run !== this.generation) return;
            const event = JSON.parse(String(data));
            if (event.type === "voice.ready" && !ready) {
              ready = true;
              await this.deps.audio.start({
                inputSampleRate: event.inputSampleRate || 24000,
                outputSampleRate: event.outputSampleRate || 24000,
              });
              if (run !== this.generation) return;
              clearTimeout(this.timeout);
              this.update({ status: "Listening" });
            } else if (event.type === "audio.delta") {
              await this.deps.audio.enqueueAudio({
                pcmBase64: event.audio,
                responseId: String(event.responseId),
              });
              if (run === this.generation) this.update({ status: "Odpowiadam" });
            } else if (event.type === "audio.done")
              await this.deps.audio.finishResponse(String(event.responseId));
            else if (event.type === "playback.clear") await this.deps.audio.clearPlayback();
            else if (event.type === "input.suspend" || event.type === "input.resume") {
              this.suspended = event.type === "input.suspend";
              await this.deps.audio.setMuted(this.suspended || this.state.muted);
              if (this.suspended) this.send({ type: "input.suspend.ack" });
            } else if (event.type === "voice.state") {
              const status = {
                listening: "Listening",
                thinking: "Thinking…",
                speaking: "Odpowiadam",
              }[event.state as string];
              if (status) this.update({ status });
            } else if (event.type === "transcript.final") {
              const id = `${event.role}:${event.responseId || event.turnId}`;
              const entry: VoiceMessage = {
                id,
                role: String(event.role),
                content: String(event.content || ""),
              };
              this.update({
                messages: [...this.state.messages.filter((m) => m.id !== id), entry].slice(-100),
              });
            } else if (event.type === "error" || event.type === "voice.deactivated") {
              this.fail(run, "Rozmowa jest niedostępna lub zajęta. Spróbuj ponownie.");
            }
          })
          .catch(() => this.fail(run, "Nie udało się obsłużyć audio rozmowy."));
      };
      socket.onerror = () => this.fail(run, "Błąd połączenia głosowego.");
      socket.onclose = () => this.fail(run, "Połączenie głosowe zostało zamknięte.");
    } catch (error) {
      this.fail(run, error instanceof Error ? error.message : "Nie udało się rozpocząć rozmowy.");
    }
  }

  async setAudioRoute(route: VoiceAudioRoute) {
    if (!this.state.active) return;
    await this.deps.audio.setAudioRoute(route);
  }

  private fail(run: number, error: string) {
    if (run !== this.generation) return;
    this.stop();
    this.update({ error });
  }

  stop() {
    this.generation++;
    clearTimeout(this.timeout);
    this.abort?.abort();
    this.abort = null;
    this.subscriptions.forEach((subscription) => subscription.remove());
    this.subscriptions = [];
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      socket.close();
    }
    this.stopping = this.deps.audio.stop().catch(() => {});
    this.update({ active: false, muted: false, status: "Call ended" });
  }

  async toggleMute() {
    if (!this.state.active) return;
    const run = this.generation;
    const muted = !this.state.muted;
    this.update({ muted });
    try {
      await this.deps.audio.setMuted(muted || this.suspended);
      if (run === this.generation) this.send({ type: muted ? "input.mute" : "input.unmute" });
    } catch {
      this.fail(run, "Could not change the microphone state.");
    }
  }
}
