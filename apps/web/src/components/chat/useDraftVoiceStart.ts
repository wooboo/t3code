import type { CreateThreadInput } from "@t3tools/client-runtime/state/threads";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, type RefObject } from "react";
import { markPromotedDraftThreadByRef } from "../../composerDraftStore";
import { useRightPanelStore } from "../../rightPanelStore";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { cancelPendingVoiceStart, queuePendingVoiceStart } from "./pendingVoiceStart";

type VoiceDraft = {
  environmentId: EnvironmentId;
  requiresWorktree: boolean;
  input: Omit<CreateThreadInput, "title">;
};

/** Keeps gesture-acquired audio alive while a draft becomes a server thread. */
export function useDraftVoiceStart({
  routeThreadKey,
  sendInFlightRef,
  getDraft,
  setThreadError,
}: {
  routeThreadKey: string;
  sendInFlightRef: RefObject<boolean>;
  getDraft: () => VoiceDraft | null;
  setThreadError: (threadId: ThreadId, error: string) => void;
}) {
  const createThread = useOrchestrationCommand(threadEnvironment.create, { reportFailure: false });
  const navigate = useNavigate();
  const generation = useRef(0);
  useEffect(() => {
    const key = routeThreadKey;
    return () => {
      if (key) generation.current++;
    };
  }, [routeThreadKey]);

  return async () => {
    if (sendInFlightRef.current) return;
    const draft = getDraft();
    if (!draft) return;
    const { environmentId, input } = draft;
    if (draft.requiresWorktree && !input.worktreePath) {
      setThreadError(
        input.threadId,
        "Select Current checkout to start a voice conversation, or create the worktree first.",
      );
      return;
    }
    const startGeneration = generation.current;
    sendInFlightRef.current = true;
    const output = new AudioContext();
    void output.resume();
    let stream: MediaStream | undefined;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (startGeneration !== generation.current) {
        stream.getTracks().forEach((track) => track.stop());
        void output.close();
        return;
      }
      queuePendingVoiceStart(`${environmentId}:${input.threadId}`, { stream, output });
      const result = await createThread({
        environmentId,
        input: { ...input, title: "Voice conversation" },
      });
      if (result._tag === "Failure") throw Error("Could not create the voice thread. Try again.");
      const ref = scopeThreadRef(environmentId, input.threadId);
      useRightPanelStore.getState().open(ref, "voice");
      markPromotedDraftThreadByRef(ref);
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(ref),
        replace: true,
      });
    } catch (error) {
      cancelPendingVoiceStart(`${environmentId}:${input.threadId}`);
      stream?.getTracks().forEach((track) => track.stop());
      if (output.state !== "closed") void output.close();
      setThreadError(
        input.threadId,
        error instanceof Error ? error.message : "Could not start voice conversation.",
      );
    } finally {
      sendInFlightRef.current = false;
    }
  };
}
