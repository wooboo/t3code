export const voiceCallKey = ({ ownerId, environmentId, threadId }) =>
  JSON.stringify([ownerId, environmentId, threadId]);

/** A successful handoff means the voice process acknowledged it, not that the user heard it. */
export async function callUser({ sessions, starting, target, reason, context = "", incoming }) {
  const key = voiceCallKey(target);
  const active = [...sessions.values()].find((session) => session.key === key);
  if (active) {
    await active.notify({ reason, context });
    return { status: "delivered_to_voice_agent", callId: active.id };
  }
  if (starting.has(key))
    return {
      status: "connecting",
      message: "The call is still connecting. Try again once connected.",
    };
  if ([...starting].some((key) => JSON.parse(key)[0] === target.ownerId))
    return { status: "busy", message: "Another call is connecting." };
  if ([...sessions.values()].some((session) => session.ownerId === target.ownerId))
    return {
      status: "busy",
      message: "The user is in a different thread's call. Do not redirect it.",
    };
  if (incoming) return incoming.request(target, reason, context);
  return {
    status: "unavailable",
    message:
      "Incoming-call push delivery is not configured. No call was placed. Leave the information in this thread.",
  };
}
