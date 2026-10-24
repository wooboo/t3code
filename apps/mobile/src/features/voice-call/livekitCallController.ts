import { mergeVoiceHistory } from "@t3tools/client-runtime/voice-input";
import { DisconnectReason, Room, RoomEvent } from "livekit-client";
import type { VoiceCallState } from "./voiceCallController";

/** LiveKit owns duplex audio and interruption; T3 owns authentication and task execution. */
export class LivekitCallController {
  state: VoiceCallState = {
    active: false,
    muted: false,
    status: "Ready for a call",
    error: "",
    messages: [],
  };
  private generation = 0;
  private historyRequest = 0;
  private cleanup: (() => Promise<void>) | null = null;
  private stopping = Promise.resolve();
  private room: Room | null = null;
  constructor(
    private readonly deps: {
      baseUrl: string;
      threadId: string;
      environmentId?: string;
      callbackId?: string;
      bearerToken: string;
      fetch: typeof fetch;
      createRoom?: () => Room;
      startAudio(): Promise<void>;
      stopAudio(): Promise<void>;
      onChange(state: VoiceCallState): void;
      onAudioLevel?(level: number): void;
    },
  ) {}
  private url(route: string) {
    return new URL(`voice/${route}`, this.deps.baseUrl.replace(/\/?$/, "/"));
  }
  private headers() {
    return { Authorization: `Bearer ${this.deps.bearerToken}` };
  }
  private update(patch: Partial<VoiceCallState>) {
    this.state = { ...this.state, ...patch };
    this.deps.onChange(this.state);
  }
  async loadHistory(signal: AbortSignal) {
    const request = ++this.historyRequest;
    const atRequestStart = this.state.messages;
    const url = this.url("t3-history");
    url.searchParams.set("thread", this.deps.threadId);
    if (this.deps.environmentId) url.searchParams.set("environmentId", this.deps.environmentId);
    const response = await this.deps.fetch(url, { headers: this.headers(), signal });
    if (!response.ok || signal.aborted) return;
    const data = await response.json();
    if (!signal.aborted && request === this.historyRequest && Array.isArray(data.messages))
      this.update({
        messages: mergeVoiceHistory(data.messages, this.state.messages, atRequestStart),
      });
  }
  async start() {
    if (this.state.active) return;
    const generation = ++this.generation;
    this.update({ active: true, muted: false, error: "", status: "Connecting…" });
    await this.stopping;
    if (generation !== this.generation) return;
    const abort = new AbortController();
    const room = this.deps.createRoom?.() ?? new Room();
    this.room = room;
    let sessionId: string | undefined;
    const audioStarting = this.deps.startAudio();
    const release = async (id: string) => {
      await this.deps
        .fetch(this.url(`livekit/session/${encodeURIComponent(id)}`), {
          method: "DELETE",
          headers: this.headers(),
        })
        .catch(() => {});
    };
    const timeout = setTimeout(() => fail("LiveKit connection timed out."), 45000);
    this.cleanup = async () => {
      abort.abort();
      clearTimeout(timeout);
      room.removeAllListeners();
      try {
        await room.disconnect();
      } finally {
        await audioStarting.catch(() => {});
        try {
          await this.deps.stopAudio();
        } finally {
          if (sessionId) await release(sessionId);
        }
      }
    };
    const fail = (error: string) => {
      if (generation === this.generation) {
        this.stop();
        this.update({ error });
      }
    };
    try {
      await audioStarting;
      if (generation !== this.generation) return;
      const url = this.url("livekit/session");
      url.searchParams.set("thread", this.deps.threadId);
      if (this.deps.environmentId) url.searchParams.set("environmentId", this.deps.environmentId);
      const response = await this.deps.fetch(url, {
        method: "POST",
        headers: { ...this.headers(), "content-type": "application/json" },
        body: this.deps.callbackId
          ? JSON.stringify({ callbackId: this.deps.callbackId })
          : undefined,
        signal: abort.signal,
      });
      if (!response.ok) throw Error(`LiveKit: HTTP ${response.status}`);
      const connection = (await response.json()) as { id: string; url: string; token: string };
      sessionId = connection.id;
      if (generation !== this.generation) {
        await release(sessionId);
        return;
      }
      room.on(RoomEvent.DataReceived, (bytes, participant, _kind, topic) => {
        if (
          generation !== this.generation ||
          participant?.identity !== `voice-agent-${connection.id}` ||
          topic !== "t3.voice.prototype"
        )
          return;
        try {
          const event = JSON.parse(new TextDecoder().decode(bytes));
          if (event.type === "transcript.final" && typeof event.content === "string")
            this.update({
              messages: [
                ...this.state.messages.filter((m) => m.id !== event.id),
                { id: String(event.id), role: String(event.role), content: event.content },
              ].slice(-100),
            });
          if (event.type === "voice.state") {
            const labels: Record<string, string> = {
              listening: "Listening",
              thinking: "Thinking…",
              speaking: "Speaking",
            };
            if (labels[event.state]) this.update({ status: labels[event.state]! });
          }
          if (event.type === "call.ended") void this.stop();
          if (event.type === "error") fail(String(event.message));
        } catch {
          fail("Invalid LiveKit response.");
        }
      });
      room.on(RoomEvent.ActiveSpeakersChanged, () =>
        this.deps.onAudioLevel?.(room.localParticipant.audioLevel),
      );
      room.on(RoomEvent.Disconnected, (reason) => {
        if (generation !== this.generation) return;
        if (reason === DisconnectReason.ROOM_DELETED) void this.stop();
        else fail("LiveKit disconnected the call.");
      });
      room.on(RoomEvent.Reconnecting, () => this.update({ status: "Reconnecting…" }));
      room.on(RoomEvent.Reconnected, () => this.update({ status: "Listening" }));
      await room.connect(connection.url, connection.token);
      if (generation !== this.generation) {
        await room.disconnect();
        return;
      }
      await room.localParticipant.setMicrophoneEnabled(true);
      if (generation !== this.generation) {
        await room.disconnect();
        return;
      }
      clearTimeout(timeout);
      this.update({ status: "Listening" });
    } catch (error) {
      fail(error instanceof Error ? error.message : "Could not connect to LiveKit.");
    }
  }
  stop() {
    this.generation++;
    const cleanup = this.cleanup;
    this.cleanup = null;
    this.room = null;
    if (cleanup) this.stopping = cleanup().catch(() => {});
    this.update({ active: false, muted: false, status: "Call ended" });
    return this.stopping;
  }
  async toggleMute() {
    if (!this.room || !this.state.active) return;
    const generation = this.generation;
    const muted = !this.state.muted;
    try {
      await this.room.localParticipant.setMicrophoneEnabled(!muted);
      if (generation === this.generation) this.update({ muted });
    } catch {
      if (generation === this.generation)
        this.update({ error: "Could not change the microphone state." });
    }
  }
}
