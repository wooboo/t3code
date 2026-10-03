import { llm } from "@livekit/agents";
import { z } from "zod";

export function endCallTool({ endCall, onError }) {
  let requested = false;
  return llm.tool({
    description:
      "Zakończ aktywną rozmowę i wyłącz kanał głosowy na wyraźne polecenie użytkownika. Zadania w T3 działają dalej.",
    parameters: z.object({}),
    execute: async () => {
      if (!requested) {
        requested = true;
        // Return from the tool before session.close cancels/joins the active tool task.
        setImmediate(() => void Promise.resolve().then(endCall).catch(onError));
      }
      return { state: "ending" };
    },
  });
}

/** Release audio even when notifying the caller or deleting the room fails. */
export async function endVoiceCall({ room, deleteRoom, close }) {
  try {
    await room.localParticipant
      ?.publishData(Buffer.from(JSON.stringify({ type: "call.ended" })), {
        reliable: true,
        topic: "t3.voice.prototype",
      })
      .catch(() => {});
    await deleteRoom();
  } finally {
    await close();
  }
}
