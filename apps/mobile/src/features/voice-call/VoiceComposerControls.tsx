import { useEffect, useState, type RefObject } from "react";
import { Platform } from "react-native";
import { ComposerActionButton } from "../../components/ComposerToolbar";
import type { ComposerEditorHandle } from "../../components/ComposerEditor";
import {
  ComposerDictationPrimaryAction,
  ComposerDictationStartAction,
} from "../voice-input/ComposerDictationControl";
import type { useVoiceInputController } from "../voice-input/useVoiceInputController";
import { resolveVoiceComposerPresentation } from "../voice-input/voiceInputPresentation";
import { VoiceCallPanel } from "./VoiceCallPanel";
import type { VoiceCallHandle } from "./useVoiceCall";

type Dictation = ReturnType<typeof useVoiceInputController>;

export function useVoiceComposerCall(input: {
  call: VoiceCallHandle | undefined;
  initiallyOpen: boolean;
  editorRef: RefObject<ComposerEditorHandle | null>;
  dictationBusy: boolean;
}) {
  const [open, setOpen] = useState(input.initiallyOpen);
  const blocksText = input.call?.state.active === true && !input.call.state.muted;
  useEffect(() => {
    if (blocksText) input.editorRef.current?.blur();
  }, [blocksText, input.editorRef]);
  return {
    call: input.call,
    blocksText,
    show: () => setOpen(true),
    toggle: () => setOpen((value) => !value),
    panel:
      input.call && open ? (
        <VoiceCallPanel
          call={input.call}
          canStart={!input.dictationBusy}
          onClose={() => setOpen(false)}
        />
      ) : null,
  };
}

export function VoiceComposerControls({
  call,
  dictation,
  expanded,
}: {
  call: ReturnType<typeof useVoiceComposerCall>;
  dictation: Dictation;
  expanded: boolean;
}) {
  return (
    <>
      {call.call && Platform.OS === "android" ? (
        <ComposerActionButton
          accessibilityLabel={
            call.call.state.active
              ? expanded
                ? `Rozmowa głosowa aktywna: ${call.call.state.muted ? "mikrofon wyciszony" : call.call.state.status}`
                : "Rozmowa głosowa aktywna — otwórz panel"
              : "Otwórz panel głosu"
          }
          icon={call.call.state.muted ? "mic.slash" : "mic"}
          variant={call.call.state.active ? "danger" : "primary"}
          onPress={expanded ? call.toggle : call.show}
        />
      ) : null}
      {expanded ? (
        <ComposerDictationPrimaryAction
          state={dictation.state}
          presentation={resolveVoiceComposerPresentation(dictation.state, dictation.elapsedSeconds)}
          isAvailable={dictation.isAvailable}
          disabled={call.call?.state.active === true}
          onStart={dictation.start}
          onConfirm={dictation.stop}
          onCancel={dictation.cancel}
        />
      ) : (
        <ComposerDictationStartAction
          state={dictation.state}
          isAvailable={dictation.isAvailable}
          onStart={() => {
            if (!call.call?.state.active) void dictation.start();
          }}
          onCancel={dictation.cancel}
        />
      )}
    </>
  );
}
