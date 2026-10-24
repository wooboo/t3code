import { useCallback } from "react";

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { mapAtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import {
  ThreadId,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";

import { threadEnvironment } from "../../state/threads";
import type { DraftComposerAttachment } from "../../lib/composerImages";
import { makeTurnCommandMetadata } from "../../lib/commandMetadata";
import { deriveThreadTitleFromPrompt } from "../../lib/projectThreadStartTurn";
import { isModelSelectionUnavailable } from "../../lib/modelOptions";
import { useAtomCommand } from "../../state/use-atom-command";
import { setPendingConnectionError } from "../../state/use-remote-environment-registry";
import { appAtomRegistry } from "../../state/atom-registry";
import { serverEnvironment } from "../../state/server";
import { resolveProviderInteractionMode } from "../../state/legacy-plan-mode";

export function useCreateVoiceThread() {
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });

  return useCallback(
    async (input: {
      readonly project: EnvironmentProject;
      readonly modelSelection: ModelSelection;
      readonly envMode: "local" | "worktree";
      readonly branch: string | null;
      readonly worktreePath: string | null;
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: ProviderInteractionMode;
      readonly initialMessageText: string;
      readonly initialAttachments: ReadonlyArray<DraftComposerAttachment>;
    }) => {
      const metadata = makeTurnCommandMetadata();
      const threadId = ThreadId.make(metadata.threadId);
      const initialMessageText = input.initialMessageText.trim();

      const validationError =
        input.envMode === "worktree"
          ? new Error(
              "Aby rozpocząć głosem, wybierz istniejący katalog pracy. Nowy worktree wymaga pierwszej wiadomości tekstowej.",
            )
          : initialMessageText || input.initialAttachments.length > 0
            ? new Error("Wyślij lub usuń treść szkicu przed utworzeniem pustego czatu głosowego.")
            : null;
      if (validationError !== null) {
        setPendingConnectionError(validationError.message);
        return AsyncResult.failure(Cause.fail(validationError));
      }

      const serverConfig = appAtomRegistry.get(
        serverEnvironment.configValueAtom(input.project.environmentId),
      );
      const providerError = !serverConfig
        ? "Provider settings are still loading. Try again."
        : isModelSelectionUnavailable(serverConfig, input.modelSelection, input.project.id)
          ? "Antigravity model unavailable. Set it up on web or desktop, or choose another model."
          : null;
      if (providerError !== null) {
        setPendingConnectionError(providerError);
        return AsyncResult.failure(Cause.fail(new Error(providerError)));
      }
      const provider = serverConfig?.providers.find(
        (candidate) => candidate.instanceId === input.modelSelection.instanceId,
      );

      const result = await createThread({
        environmentId: input.project.environmentId,
        input: {
          threadId,
          projectId: input.project.id,
          title: deriveThreadTitleFromPrompt(""),
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimeMode,
          interactionMode: resolveProviderInteractionMode(provider, input.interactionMode),
          branch: input.branch,
          worktreePath: input.worktreePath,
          createdAt: metadata.createdAt,
        },
      });
      if (AsyncResult.isFailure(result)) return result;
      setPendingConnectionError(null);
      return mapAtomCommandResult(result, () =>
        scopeThreadRef(input.project.environmentId, threadId),
      );
    },
    [createThread],
  );
}
