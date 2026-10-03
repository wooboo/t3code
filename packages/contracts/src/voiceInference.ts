import * as Schema from "effect/Schema";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { ServerProvider } from "./server.ts";

/** A stateless conversation helper; never a command sent to the coding thread. */
export const VoiceInferenceInput = Schema.Struct({
  modelSelection: ModelSelection,
  prompt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200_000)),
});
export type VoiceInferenceInput = typeof VoiceInferenceInput.Type;

export const VoiceInferenceOutput = Schema.Struct({
  text: Schema.String.check(Schema.isMaxLength(32_000)),
  toolCalls: Schema.Array(
    Schema.Struct({
      name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
      arguments: Schema.String.check(Schema.isMaxLength(32_000)),
    }),
  ).check(Schema.isMaxLength(8)),
});
export type VoiceInferenceOutput = typeof VoiceInferenceOutput.Type;

export const VoiceInferenceEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text.delta"), delta: Schema.String }),
  Schema.Struct({ type: Schema.Literal("completed"), result: VoiceInferenceOutput }),
  Schema.Struct({ type: Schema.Literal("error"), message: Schema.String }),
]);
export type VoiceInferenceEvent = typeof VoiceInferenceEvent.Type;

export const VoiceInferenceResult = Schema.Struct({
  ...VoiceInferenceOutput.fields,
  elapsedMs: Schema.Number,
  streaming: Schema.Literal(false),
});

export const VoiceInferenceCatalogue = Schema.Struct({
  providers: Schema.Array(ServerProvider),
  capabilities: Schema.Array(
    Schema.Struct({
      instanceId: ProviderInstanceId,
      supported: Schema.Boolean,
      reason: Schema.optional(Schema.String),
      streaming: Schema.Boolean,
    }),
  ),
});
