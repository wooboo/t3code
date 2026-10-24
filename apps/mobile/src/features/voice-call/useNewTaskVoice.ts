import { useRef } from "react";
import { Alert } from "react-native";
import { StackActions } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useServerConfigs } from "../../state/entities";
import { clearComposerDraftContent } from "../../state/use-composer-drafts";
import { useCreateVoiceThread } from "./useCreateVoiceThread";
import { useVoiceHost } from "./useVoiceHost";

export function useNewTaskVoice() {
  const host = useVoiceHost();
  const configs = useServerConfigs();
  const createThread = useCreateVoiceThread();
  const creating = useRef(false);

  function validate(input: {
    environmentId: EnvironmentId;
    connected: boolean;
    createOnly: boolean;
    workspaceMode: "local" | "worktree";
  }) {
    const reason =
      configs.get(host.environmentId ?? input.environmentId)?.environment.capabilities.voice ===
      false
        ? "To środowisko nie obsługuje voice. Wybierz serwer oznaczony Voice w Ustawienia → Voice."
        : !input.connected
          ? "Połącz się z serwerem przed rozpoczęciem rozmowy."
          : input.createOnly && input.workspaceMode === "worktree"
            ? "Aby rozpocząć głosem, wybierz istniejący katalog pracy. Nowy worktree wymaga pierwszej wiadomości tekstowej."
            : null;
    if (reason) Alert.alert("Rozmowa głosowa", reason);
    return reason === null;
  }

  async function createEmpty(
    input: Parameters<typeof createThread>[0],
    draftKey: string,
    setSubmitting: (submitting: boolean) => void,
  ) {
    if (creating.current) return null;
    creating.current = true;
    setSubmitting(true);
    try {
      const result = await createThread(input);
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          Alert.alert(
            "Could not start task",
            error instanceof Error ? error.message : "The task could not be started.",
          );
        }
        return null;
      }
      clearComposerDraftContent(draftKey, {
        clearModelSelection: true,
        clearWorkspaceSelection: true,
      });
      return StackActions.replace("Thread", {
        environmentId: String(result.value.environmentId),
        threadId: String(result.value.threadId),
        openVoice: true,
      });
    } finally {
      creating.current = false;
      setSubmitting(false);
    }
  }

  return { validate, createEmpty };
}
