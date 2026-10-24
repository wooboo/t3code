import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  clear: vi.fn(),
  alert: vi.fn(),
  host: { environmentId: null as string | null },
  configs: new Map<string, { environment: { capabilities: { voice: boolean } } }>(),
}));
vi.mock("react", () => ({ useRef: (current: unknown) => ({ current }) }));
vi.mock("react-native", () => ({ Alert: { alert: mocks.alert } }));
vi.mock("@react-navigation/native", () => ({
  StackActions: { replace: (name: string, params: unknown) => ({ name, params }) },
}));
vi.mock("../../state/entities", () => ({ useServerConfigs: () => mocks.configs }));
vi.mock("../../state/use-composer-drafts", () => ({ clearComposerDraftContent: mocks.clear }));
vi.mock("./useCreateVoiceThread", () => ({ useCreateVoiceThread: () => mocks.create }));
vi.mock("./useVoiceHost", () => ({ useVoiceHost: () => mocks.host }));
import { useNewTaskVoice } from "./useNewTaskVoice";

const validation = {
  environmentId: EnvironmentId.make("target"),
  connected: true,
  createOnly: true,
  workspaceMode: "local" as const,
};
const input = {} as Parameters<ReturnType<typeof useNewTaskVoice>["createEmpty"]>[0];
const success = () => AsyncResult.success({ environmentId: "target", threadId: "thread" });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.configs.clear();
  mocks.host.environmentId = null;
  mocks.create.mockResolvedValue(success());
});
describe("new task voice startup", () => {
  it("checks the selected voice host instead of requiring voice on the thread environment", () => {
    mocks.host.environmentId = "host";
    mocks.configs.set("host", { environment: { capabilities: { voice: true } } });
    mocks.configs.set("target", { environment: { capabilities: { voice: false } } });
    expect(useNewTaskVoice().validate(validation)).toBe(true);
    mocks.configs.set("host", { environment: { capabilities: { voice: false } } });
    expect(useNewTaskVoice().validate(validation)).toBe(false);
  });
  it("falls back to the thread environment and still requires its connection", () => {
    mocks.configs.set("target", { environment: { capabilities: { voice: false } } });
    expect(useNewTaskVoice().validate(validation)).toBe(false);
    mocks.configs.clear();
    expect(useNewTaskVoice().validate({ ...validation, connected: false })).toBe(false);
  });
  it("allows a typed launch to create a worktree but requires an existing workspace for an empty launch", () => {
    expect(useNewTaskVoice().validate({ ...validation, workspaceMode: "worktree" })).toBe(false);
    expect(
      useNewTaskVoice().validate({ ...validation, workspaceMode: "worktree", createOnly: false }),
    ).toBe(true);
  });
  it("coalesces concurrent empty launches until creation completes", async () => {
    let resolve!: (result: ReturnType<typeof success>) => void;
    mocks.create.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const voice = useNewTaskVoice();
    const submitting = vi.fn();
    const first = voice.createEmpty(input, "draft", submitting);
    expect(await voice.createEmpty(input, "draft", submitting)).toBe(null);
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.clear).not.toHaveBeenCalled();
    resolve(success());
    expect(await first).toEqual({
      name: "Thread",
      params: { environmentId: "target", threadId: "thread", openVoice: true },
    });
    expect(submitting.mock.calls).toEqual([[true], [false]]);
    expect(mocks.clear).toHaveBeenCalledOnce();
  });
  it("preserves the draft on failure and releases the lock for retry", async () => {
    mocks.create.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("offline"))));
    const voice = useNewTaskVoice();
    const submitting = vi.fn();
    expect(await voice.createEmpty(input, "draft", submitting)).toBe(null);
    expect(mocks.clear).not.toHaveBeenCalled();
    expect(submitting.mock.calls).toEqual([[true], [false]]);
    expect(await voice.createEmpty(input, "draft", submitting)).not.toBe(null);
    expect(mocks.create).toHaveBeenCalledTimes(2);
  });
  it("keeps interruption silent and preserves the draft", async () => {
    mocks.create.mockResolvedValueOnce(AsyncResult.failure(Cause.interrupt()));
    expect(await useNewTaskVoice().createEmpty(input, "draft", vi.fn())).toBe(null);
    expect(mocks.alert).not.toHaveBeenCalled();
    expect(mocks.clear).not.toHaveBeenCalled();
  });
});
