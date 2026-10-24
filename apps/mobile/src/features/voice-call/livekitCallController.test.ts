import { expect, it, vi } from "vite-plus/test";
import { DisconnectReason, Room, RoomEvent } from "livekit-client";
import { LivekitCallController } from "./livekitCallController";

function fixture() {
  const room = new Room();
  vi.spyOn(room, "connect").mockResolvedValue(undefined);
  const disconnect = vi.spyOn(room, "disconnect").mockResolvedValue(undefined);
  const microphone = vi
    .spyOn(room.localParticipant, "setMicrophoneEnabled")
    .mockResolvedValue(undefined);
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    Response.json({ id: "test", token: "token", url: "wss://room.test" }),
  );
  const stopAudio = vi.fn(async () => {});
  const deps = {
    baseUrl: "https://t3.test",
    threadId: "thread",
    bearerToken: "bearer",
    fetch: fetcher as typeof fetch,
    createRoom: () => room,
    startAudio: async () => {},
    stopAudio,
    onChange: vi.fn(),
  };
  const controller = new LivekitCallController(deps);
  return { controller, deps, room, disconnect, microphone, fetcher, stopAudio };
}
it("refreshes offline voice results in history order without duplicating earlier messages", async () => {
  const f = fixture();
  const original = { id: "first", role: "user", content: "Wykonaj zadanie" };
  const result = { id: "agent:result", role: "assistant", content: "Zadanie gotowe" };
  f.fetcher.mockResolvedValueOnce(Response.json({ messages: [original] }));
  await f.controller.loadHistory(new AbortController().signal);
  f.fetcher.mockResolvedValueOnce(Response.json({ messages: [original, result] }));
  await f.controller.loadHistory(new AbortController().signal);
  expect(f.controller.state.messages).toEqual([original, result]);
});
it("releases a late audio session after hangup without connecting or publishing", async () => {
  const f = fixture();
  let grant!: () => void;
  f.deps.startAudio = () =>
    new Promise<void>((resolve) => {
      grant = resolve;
    });
  const start = f.controller.start();
  await Promise.resolve();
  f.controller.stop();
  grant();
  await start;
  await vi.waitFor(() => expect(f.stopAudio).toHaveBeenCalledOnce());
  expect(f.room.connect).not.toHaveBeenCalled();
  expect(f.microphone).not.toHaveBeenCalled();
  expect(f.controller.state.active).toBe(false);
});
it("accepts only agent transcripts, mutes the microphone and deletes its session on stop", async () => {
  const f = fixture();
  await f.controller.start();
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      type: "transcript.final",
      id: "message",
      role: "assistant",
      content: "Cześć",
    }),
  );
  const participant = { identity: "voice-agent-test" } as Parameters<
    typeof f.room.emit<RoomEvent.DataReceived>
  >[2];
  f.room.emit(
    RoomEvent.DataReceived,
    bytes,
    { ...participant, identity: "other" } as typeof participant,
    undefined,
    "t3.voice.prototype",
  );
  expect(f.controller.state.messages).toHaveLength(0);
  f.room.emit(RoomEvent.DataReceived, bytes, participant, undefined, "t3.voice.prototype");
  expect(f.controller.state.messages[0]?.content).toBe("Cześć");
  await f.controller.toggleMute();
  expect(f.microphone).toHaveBeenLastCalledWith(false);
  expect(f.controller.state.muted).toBe(true);
  f.controller.stop();
  await vi.waitFor(() =>
    expect(
      f.fetcher.mock.calls.some((call) => String(call[0]).endsWith("/voice/livekit/session/test")),
    ).toBe(true),
  );
  expect(f.disconnect).toHaveBeenCalledOnce();
});

it("sends remote thread identity to the voice host using only the voice host credential", async () => {
  const f = fixture();
  const controller = new LivekitCallController({ ...f.deps, environmentId: "remote-environment" });
  await controller.start();
  const [input, init] = f.fetcher.mock.calls[0]!;
  const url = new URL(String(input));
  expect(url.origin).toBe("https://t3.test");
  expect(url.searchParams.get("environmentId")).toBe("remote-environment");
  expect(url.searchParams.get("thread")).toBe("thread");
  expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer bearer");
  controller.stop();
});

it("releases background audio protection even when room disconnect fails", async () => {
  const f = fixture();
  await f.controller.start();
  f.disconnect.mockRejectedValueOnce(new Error("transport already closed"));
  await f.controller.stop();
  expect(f.stopAudio).toHaveBeenCalledOnce();
  expect(
    f.fetcher.mock.calls.some(
      ([url, init]) =>
        String(url).endsWith("/voice/livekit/session/test") && init?.method === "DELETE",
    ),
  ).toBe(true);
  expect(f.controller.state.active).toBe(false);
});

it("accepts a callback only through its bound thread and does not publish audio when it expired", async () => {
  const f = fixture();
  f.fetcher.mockResolvedValueOnce(new Response(null, { status: 409 }));
  const controller = new LivekitCallController({
    ...f.deps,
    environmentId: "remote",
    callbackId: "invitation",
  });
  await controller.start();
  const [input, init] = f.fetcher.mock.calls[0]!;
  expect(new URL(String(input)).searchParams.get("environmentId")).toBe("remote");
  expect(new URL(String(input)).searchParams.get("thread")).toBe("thread");
  expect(JSON.parse(String(init?.body))).toEqual({ callbackId: "invitation" });
  expect(f.room.connect).not.toHaveBeenCalled();
  expect(f.microphone).not.toHaveBeenCalled();
  await controller.stop();
  expect(f.stopAudio).toHaveBeenCalledOnce();
  expect(controller.state.error).toContain("409");
});

it("only the session agent can hang up, releasing audio and ignoring late disconnect errors", async () => {
  const f = fixture();
  await f.controller.start();
  const bytes = new TextEncoder().encode(JSON.stringify({ type: "call.ended" }));
  const participant = { identity: "other" } as Parameters<
    typeof f.room.emit<RoomEvent.DataReceived>
  >[2];
  f.room.emit(RoomEvent.DataReceived, bytes, participant, undefined, "t3.voice.prototype");
  expect(f.controller.state.active).toBe(true);
  f.room.emit(
    RoomEvent.DataReceived,
    bytes,
    { ...participant, identity: "voice-agent-test" } as typeof participant,
    undefined,
    "t3.voice.prototype",
  );
  await f.controller.stop();
  f.room.emit(RoomEvent.Disconnected);
  expect(f.controller.state.active).toBe(false);
  expect(f.controller.state.error).toBe("");
  expect(f.disconnect).toHaveBeenCalledOnce();
  expect(f.stopAudio).toHaveBeenCalledOnce();
  expect(
    f.fetcher.mock.calls.some(
      ([url, init]) => String(url).endsWith("/session/test") && init?.method === "DELETE",
    ),
  ).toBe(true);
});

it("room deletion ends the call even if the final data event is lost", async () => {
  const f = fixture();
  await f.controller.start();
  f.room.emit(RoomEvent.Disconnected, DisconnectReason.ROOM_DELETED);
  await f.controller.stop();
  expect(f.controller.state.active).toBe(false);
  expect(f.controller.state.error).toBe("");
  expect(f.stopAudio).toHaveBeenCalledOnce();
});

it("treats refreshed history as authoritative and bounds messages received during fetch", async () => {
  const f = fixture();
  const old = Array.from({ length: 100 }, (_, i) => ({
    id: String(i),
    role: "assistant",
    content: String(i),
  }));
  f.controller.state = { ...f.controller.state, messages: old };
  let respond!: (response: Response) => void;
  f.fetcher.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        respond = resolve;
      }),
  );
  const loading = f.controller.loadHistory(new AbortController().signal);
  const live = { id: "live", role: "assistant", content: "during refresh" };
  f.controller.state = { ...f.controller.state, messages: [...old, live] };
  const server = [...old.slice(1), { id: "100", role: "assistant", content: "result" }];
  respond(Response.json({ messages: server }));
  await loading;
  expect(f.controller.state.messages).toEqual([...server.slice(1), live]);
  f.fetcher.mockResolvedValueOnce(Response.json({ messages: [] }));
  await f.controller.loadHistory(new AbortController().signal);
  expect(f.controller.state.messages).toEqual([]);
});

it("ignores an older history response arriving after the latest refresh", async () => {
  const f = fixture();
  let respond!: (response: Response) => void;
  f.fetcher.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        respond = resolve;
      }),
  );
  const old = f.controller.loadHistory(new AbortController().signal);
  const message = { id: "latest", role: "assistant", content: "latest" };
  f.fetcher.mockResolvedValueOnce(Response.json({ messages: [message] }));
  await f.controller.loadHistory(new AbortController().signal);
  respond(Response.json({ messages: [] }));
  await old;
  expect(f.controller.state.messages).toEqual([message]);
});
