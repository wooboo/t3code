import { CallUserInput, CallUserResult, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";
import { McpInvocationContext } from "../../McpInvocationContext.ts";

export class VoiceCallToolError extends Schema.TaggedError<VoiceCallToolError>()(
  "VoiceCallToolError",
  {
    message: Schema.String,
  },
) {}

export const VoiceToolkit = Toolkit.make(
  Tool.make("call_user", {
    description:
      "Ask to speak with the user about this thread now. Use when the user has asked you to call back or authorized voice contact. You decide when a conversation is useful. If the user is already in this thread's voice call, hands the reason and context to the voice agent. If no call is active, requests an incoming call on the registered Android phone. A ring_requested result only means the push service accepted the request. Do not retry automatically. Inspect the result: delivery to the voice agent does not mean the user heard it, and unavailable means no call was placed. Never claim to have called when unavailable. The environment, thread and recipient come from your authenticated session; do not pass phone numbers or thread IDs.",
    parameters: CallUserInput,
    success: CallUserResult,
    failure: Schema.Union([VoiceCallToolError, OrchestratorMcpFailure]),
    dependencies: [McpInvocationContext],
  })
    .annotate(Tool.Title, "Call user")
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, false)
    .annotate(Tool.OpenWorld, false),
);
