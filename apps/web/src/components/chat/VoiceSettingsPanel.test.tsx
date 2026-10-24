import { act, useEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { useVoiceSettings } from "./VoiceSettingsPanel";

let current: ReturnType<typeof useVoiceSettings>;
let root: ReactTestRenderer;
function Probe() {
  const state = useVoiceSettings("__global__", true);
  useEffect(() => {
    current = state;
  });
  return null;
}
afterEach(async () => {
  await act(() => root?.unmount());
  vi.unstubAllGlobals();
});

it("stages model and instruction edits until save, supports discard, and retains failed edits", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), { location: { origin: "https://voice.test" } }),
  );
  const config = {
    modelSelection: null,
    instructions: { global: "Original", project: "", thread: "" },
    enabledSkills: [],
  };
  let fail = false;
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (init?.method === "PATCH")
      return fail
        ? new Response("failure", { status: 500 })
        : Response.json({
            config: {
              ...config,
              ...JSON.parse(String(init.body)),
              instructions: {
                ...config.instructions,
                ...JSON.parse(String(init.body)).instructions,
              },
            },
          });
    return Response.json({
      config,
      catalog: { providers: [] },
      context: { skills: [], agents: [], loadedSkills: [], omittedSkills: [] },
    });
  });
  vi.stubGlobal("fetch", fetcher);
  await act(() => {
    root = create(<Probe />);
  });
  expect(current.data?.config.autoCallback).toBe(false);
  await act(() => current.update({ instructions: { global: "Changed" } }));
  expect(current.changed).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await act(() => current.reset());
  expect(current.changed).toBe(false);
  expect(current.data?.config.instructions.global).toBe("Original");
  await act(() => current.update({ instructions: { global: "Saved" }, autoCallback: true }));
  await act(() => current.save());
  expect(current.changed).toBe(false);
  expect(current.data?.config.instructions.global).toBe("Saved");
  expect(current.data?.config.autoCallback).toBe(true);
  await act(() => current.update({ instructions: { global: "Retry me" }, autoCallback: false }));
  fail = true;
  await act(async () => {
    await expect(current.save()).rejects.toThrow();
  });
  expect(current.changed).toBe(true);
  expect(current.data?.config.instructions.global).toBe("Retry me");
  expect(current.data?.config.autoCallback).toBe(false);
  expect(current.error).toContain("Could not save");
  fail = false;
  await act(() => current.save());
  expect(current.data?.config.autoCallback).toBe(false);
  expect(current.changed).toBe(false);
});
