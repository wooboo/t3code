import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { ComposerEditorHandle } from "../../components/ComposerEditor";
import type { VoiceCallHandle } from "./useVoiceCall";

vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("../../components/ComposerToolbar", () => ({ ComposerActionButton: "Action" }));
vi.mock("../voice-input/ComposerDictationControl", () => ({
  ComposerDictationPrimaryAction: "DictationPrimary",
  ComposerDictationStartAction: "DictationStart",
}));
vi.mock("./VoiceCallPanel", () => ({ VoiceCallPanel: "CallPanel" }));
import { useVoiceComposerCall } from "./VoiceComposerControls";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
});

it("blocks and blurs text only while an active call is unmuted", async () => {
  const blur = vi.fn();
  const editorRef = { current: { blur } as unknown as ComposerEditorHandle };
  let state: ReturnType<typeof useVoiceComposerCall>;
  function Harness({ active, muted }: { active: boolean; muted: boolean }) {
    const current = useVoiceComposerCall({
      call: { state: { active, muted } } as VoiceCallHandle,
      initiallyOpen: false,
      editorRef,
      dictationBusy: false,
    });
    useLayoutEffect(() => {
      state = current;
    });
    return null;
  }
  await act(async () => {
    renderer = create(<Harness active={false} muted={false} />);
  });
  expect(state!.blocksText).toBe(false);
  expect(blur).not.toHaveBeenCalled();
  await act(async () => {
    renderer!.update(<Harness active muted={false} />);
  });
  expect(state!.blocksText).toBe(true);
  expect(blur).toHaveBeenCalledOnce();
  await act(async () => {
    renderer!.update(<Harness active muted />);
  });
  expect(state!.blocksText).toBe(false);
  expect(blur).toHaveBeenCalledOnce();
});

it("closing the panel preserves the active call and allows reopening", async () => {
  const hangup = vi.fn();
  const call = { state: { active: true, muted: false }, hangup } as unknown as VoiceCallHandle;
  const editorRef = { current: null };
  let state: ReturnType<typeof useVoiceComposerCall>;
  function Harness() {
    const current = useVoiceComposerCall({
      call,
      editorRef,
      initiallyOpen: true,
      dictationBusy: false,
    });
    useLayoutEffect(() => {
      state = current;
    });
    return current.panel;
  }
  await act(async () => {
    renderer = create(<Harness />);
  });
  await act(async () => {
    renderer!.root.findByType("CallPanel" as never).props.onClose();
  });
  expect(state!.panel).toBe(null);
  expect(state!.blocksText).toBe(true);
  expect(hangup).not.toHaveBeenCalled();
  await act(async () => {
    state!.show();
  });
  expect(state!.panel).not.toBe(null);
  expect(state!.call).toBe(call);
});
