import { act, useEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { useDraftVoiceStart } from "./useDraftVoiceStart";
import { cancelPendingVoiceStart, takePendingVoiceStart } from "./pendingVoiceStart";

const mocks = vi.hoisted(() => ({
  createThread: vi.fn(),
  navigate: vi.fn(),
  open: vi.fn(),
  promoted: vi.fn(),
}));
vi.mock("../../state/threads", () => ({ threadEnvironment: { create: {} } }));
vi.mock("../../state/use-orchestration-command", () => ({
  useOrchestrationCommand: () => mocks.createThread,
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("../../composerDraftStore", () => ({ markPromotedDraftThreadByRef: mocks.promoted }));
vi.mock("../../rightPanelStore", () => ({
  useRightPanelStore: { getState: () => ({ open: mocks.open }) },
}));

const environmentId = EnvironmentId.make("remote-env");
const threadId = ThreadId.make("draft-thread");
const pendingKey = `${environmentId}:${threadId}`;
const input = {
  threadId,
  projectId: ProjectId.make("project"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1" },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  branch: "main",
  worktreePath: null,
  createdAt: "2026-10-20T12:00:00.000Z",
};
let draft: ReturnType<Parameters<typeof useDraftVoiceStart>[0]["getDraft"]>;
let start: ReturnType<typeof useDraftVoiceStart>;
let root: ReactTestRenderer | undefined;
let busy: { current: boolean };
const setError = vi.fn();
const stop = vi.fn();
const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;
const resume = vi.fn();
const close = vi.fn();
const getUserMedia = vi.fn();
function Probe({ routeKey = pendingKey }: { routeKey?: string }) {
  const currentStart = useDraftVoiceStart({
    routeThreadKey: routeKey,
    sendInFlightRef: busy,
    getDraft: () => draft,
    setThreadError: setError,
  });
  useEffect(() => {
    start = currentStart;
  });
  return null;
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal(
    "AudioContext",
    class {
      state = "running";
      resume = resume;
      close = close;
    },
  );
  draft = { environmentId, input, requiresWorktree: false };
  busy = { current: false };
  getUserMedia.mockResolvedValue(stream);
  mocks.createThread.mockResolvedValue({ _tag: "Success" });
  mocks.navigate.mockResolvedValue(undefined);
  await act(() => {
    root = create(<Probe />);
  });
});
afterEach(async () => {
  await act(() => root?.unmount());
  cancelPendingVoiceStart(pendingKey);
  vi.unstubAllGlobals();
});

it("acquires audio in the user gesture and hands it to the promoted remote thread", async () => {
  const operation = start();
  expect(resume).toHaveBeenCalledOnce();
  expect(getUserMedia).toHaveBeenCalledOnce();
  expect(busy.current).toBe(true);
  await operation;
  expect(mocks.createThread).toHaveBeenCalledWith({
    environmentId,
    input: { ...input, title: "Voice conversation" },
  });
  expect(mocks.open).toHaveBeenCalledWith({ environmentId, threadId }, "voice");
  expect(mocks.promoted).toHaveBeenCalledWith({ environmentId, threadId });
  expect(mocks.navigate).toHaveBeenCalledWith({
    to: "/$environmentId/$threadId",
    params: { environmentId, threadId },
    replace: true,
  });
  expect(takePendingVoiceStart(pendingKey)?.stream).toBe(stream);
  expect(stop).not.toHaveBeenCalled();
  expect(busy.current).toBe(false);
});

it("releases microphone permission resolving after a route change", async () => {
  let grant!: (value: MediaStream) => void;
  getUserMedia.mockReturnValue(
    new Promise<MediaStream>((resolve) => {
      grant = resolve;
    }),
  );
  const operation = start();
  await act(() => root?.update(<Probe routeKey="another-env:another-thread" />));
  grant(stream);
  await operation;
  expect(stop).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
  expect(mocks.createThread).not.toHaveBeenCalled();
  expect(takePendingVoiceStart(pendingKey)).toBeUndefined();
  expect(busy.current).toBe(false);
});

it("releases microphone permission resolving after unmount", async () => {
  let grant!: (value: MediaStream) => void;
  getUserMedia.mockReturnValue(
    new Promise<MediaStream>((resolve) => {
      grant = resolve;
    }),
  );
  const operation = start();
  await act(() => root?.unmount());
  root = undefined;
  grant(stream);
  await operation;
  expect(stop).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
  expect(mocks.navigate).not.toHaveBeenCalled();
});

it.each(["create", "navigate", "microphone"])(
  "cleans up a %s failure and unlocks sending",
  async (failure) => {
    if (failure === "create") mocks.createThread.mockResolvedValue({ _tag: "Failure" });
    if (failure === "navigate") mocks.navigate.mockRejectedValue(new Error("Navigation failed"));
    if (failure === "microphone") getUserMedia.mockRejectedValue(new Error("Microphone denied"));
    await start();
    expect(close).toHaveBeenCalled();
    if (failure !== "microphone") expect(stop).toHaveBeenCalled();
    expect(takePendingVoiceStart(pendingKey)).toBeUndefined();
    expect(setError).toHaveBeenCalledWith(threadId, expect.any(String));
    expect(busy.current).toBe(false);
  },
);

it("requires an existing worktree before asking for microphone permission", async () => {
  draft = { environmentId, input, requiresWorktree: true };
  await start();
  expect(getUserMedia).not.toHaveBeenCalled();
  expect(setError).toHaveBeenCalledWith(threadId, expect.stringContaining("Current checkout"));
});

it("ignores unavailable drafts and sends already in flight", async () => {
  busy.current = true;
  await start();
  busy.current = false;
  draft = null;
  await start();
  expect(getUserMedia).not.toHaveBeenCalled();
  expect(mocks.createThread).not.toHaveBeenCalled();
});
