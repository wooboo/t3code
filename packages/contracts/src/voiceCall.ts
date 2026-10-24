import * as Schema from "effect/Schema";

/** Owner-wide opt-in, evaluated again when delegated voice work finishes. */
export const VoiceCallbackSettings = Schema.Struct({
  autoCallback: Schema.Boolean,
});
export type VoiceCallbackSettings = typeof VoiceCallbackSettings.Type;

export const CallUserInput = Schema.Struct({
  reason: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(2000)),
  context: Schema.optional(Schema.String.check(Schema.isMaxLength(8000))),
});
export type CallUserInput = typeof CallUserInput.Type;

export const CallUserResult = Schema.Struct({
  status: Schema.Literals([
    "delivered_to_voice_agent",
    "ring_requested",
    "connecting",
    "busy",
    "unavailable",
  ]),
  callId: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
});
export type CallUserResult = typeof CallUserResult.Type;

export const VoiceCallInvitation = Schema.Struct({
  id: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
  environmentId: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4096)),
  threadId: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4096)),
  reason: Schema.String.check(Schema.isMaxLength(2000)),
  context: Schema.String.check(Schema.isMaxLength(8000)),
  status: Schema.Literals([
    "pending",
    "connecting",
    "accepted",
    "declined",
    "missed",
    "ended",
    "failed",
  ]),
  expiresAt: Schema.Number.check(Schema.isFinite()),
});
export type VoiceCallInvitation = typeof VoiceCallInvitation.Type;

export const VoicePushSubscription = Schema.Struct({
  endpoint: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4096)),
  keys: Schema.Struct({
    p256dh: Schema.String.check(Schema.isMaxLength(128)),
    auth: Schema.String.check(Schema.isMaxLength(128)),
  }),
});
export type VoicePushSubscription = typeof VoicePushSubscription.Type;

const UnifiedPushCallbackDevice = Schema.Struct({
  deviceId: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4096)),
  subscription: VoicePushSubscription,
  hostEnvironmentId: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4096)),
});
export const VoiceCallbackDevice = Schema.Union([
  UnifiedPushCallbackDevice,
  Schema.Struct({
    deviceId: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4096)),
    hostEnvironmentId: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4096)),
    provider: Schema.Literal("fcm"),
    token: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4096)),
    projectId: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(64)),
  }),
]);
export type VoiceCallbackDevice = typeof VoiceCallbackDevice.Type;
