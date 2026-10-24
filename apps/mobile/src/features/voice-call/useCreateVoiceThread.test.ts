import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  startTurn: vi.fn(),
  config: vi.fn(),
  error: vi.fn(),
  modelUnavailable: vi.fn(),
}));
vi.mock("react", () => ({ useCallback: (callback: unknown) => callback }));
vi.mock("../../state/threads", () => ({
  threadEnvironment: { create: "create", startTurn: "startTurn" },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: "create" | "startTurn") => mocks[command],
}));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: { get: mocks.config } }));
vi.mock("../../state/server", () => ({ serverEnvironment: { configValueAtom: () => null } }));
vi.mock("../../state/use-remote-environment-registry", () => ({
  setPendingConnectionError: mocks.error,
}));
vi.mock("../../lib/commandMetadata", () => ({
  makeTurnCommandMetadata: () => ({
    threadId: "voice-thread",
    commandId: "create-voice",
    messageId: "unused",
    createdAt: "2026-09-07T10:00:00.000Z",
  }),
}));
vi.mock("../../lib/modelOptions", () => ({ isModelSelectionUnavailable: mocks.modelUnavailable }));

import { useCreateVoiceThread } from "./useCreateVoiceThread";

function input() {
  return {
    project: {
      environmentId: EnvironmentId.make("env"),
      id: ProjectId.make("project"),
      workspaceRoot: "/project",
    } as Parameters<ReturnType<typeof useCreateVoiceThread>>[0]["project"],
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
    envMode: "local" as const,
    branch: "main",
    worktreePath: "/existing-worktree",
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    initialMessageText: "",
    initialAttachments: [],
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.modelUnavailable.mockReturnValue(false);
  mocks.config.mockReturnValue({ providers: [], environment: { capabilities: {} } });
  mocks.create.mockResolvedValue(AsyncResult.success(undefined));
  mocks.startTurn.mockResolvedValue(AsyncResult.success(undefined));
});
describe("creating a thread before the first voice message", () => {
  it("creates an empty thread in the selected workspace without starting an agent turn", async () => {
    const result = await useCreateVoiceThread()(input());
    expect(result._tag, JSON.stringify(mocks.error.mock.calls)).toBe("Success");
    expect(mocks.create).toHaveBeenCalledWith({
      environmentId: "env",
      input: expect.objectContaining({
        threadId: "voice-thread",
        projectId: "project",
        title: "New thread",
        branch: "main",
        worktreePath: "/existing-worktree",
        modelSelection: input().modelSelection,
        runtimeMode: "full-access",
      }),
    });
    expect(mocks.startTurn).not.toHaveBeenCalled();
  });
  it("does not discard text when asked to create an empty voice thread", async () => {
    const result = await useCreateVoiceThread()({
      ...input(),
      initialMessageText: "Keep my draft",
    });
    expect(result._tag).toBe("Failure");
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.startTurn).not.toHaveBeenCalled();
  });
  it("does not silently replace a new worktree with the current checkout", async () => {
    const result = await useCreateVoiceThread()({ ...input(), envMode: "worktree" });
    expect(result._tag).toBe("Failure");
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.startTurn).not.toHaveBeenCalled();
  });
  it("requires loaded provider settings", async () => {
    mocks.config.mockReturnValue(null);
    expect((await useCreateVoiceThread()(input()))._tag).toBe("Failure");
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("rejects an unavailable model", async () => {
    mocks.modelUnavailable.mockReturnValue(true);
    expect((await useCreateVoiceThread()(input()))._tag).toBe("Failure");
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("preserves draft attachments rather than creating an empty thread", async () => {
    const result = await useCreateVoiceThread()({
      ...input(),
      initialAttachments: [
        {
          id: "file",
          type: "file",
          name: "file.txt",
          mimeType: "text/plain",
          sizeBytes: 1,
          fileUri: "file:///file.txt",
        },
      ],
    });
    expect(result._tag).toBe("Failure");
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("returns creation failure so the draft screen stays open", async () => {
    mocks.create.mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("offline"))));
    const result = await useCreateVoiceThread()(input());
    expect(result._tag).toBe("Failure");
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.startTurn).not.toHaveBeenCalled();
  });
});
