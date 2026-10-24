type VoiceTranscriptEntry = { id: string; role: string; content: string };
export type VoiceTermReplacement = { from: string; to: string };

/** Longest keys first so phrases beat their substring mirrors of correct spellings. */
export function applyTermReplacements(text: string, terms?: readonly VoiceTermReplacement[]) {
  if (!terms?.length || !text) return text;
  let result = text;
  for (const { from, to } of [...terms].sort((a, b) => b.from.length - a.from.length))
    result = result.replace(new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), to);
  return result;
}

/** VAD segments remain individually addressable, but share a user bubble until a reply. */
export function groupVoiceTranscript<T extends VoiceTranscriptEntry>(entries: readonly T[]) {
  const groups: { id: string; role: string; content: string; entries: T[] }[] = [];
  for (const entry of entries) {
    const previous = groups.at(-1);
    if (entry.role === "user" && previous?.role === "user") {
      previous.entries.push(entry);
      // Some providers emit the entire utterance again after each VAD pause.
      // Replace a matching snapshot; append only genuinely new fragments.
      const cumulative =
        entry.content.startsWith(previous.content) &&
        (entry.content.length === previous.content.length ||
          /^[\s.,!?;:…]/u.test(entry.content.slice(previous.content.length)));
      previous.content = cumulative
        ? entry.content
        : [previous.content, entry.content].filter(Boolean).join(" ");
    } else {
      groups.push({ id: entry.id, role: entry.role, content: entry.content, entries: [entry] });
    }
  }
  return groups;
}

/** A refresh is authoritative for old entries; keep only changes received while it was in flight. */
export function mergeVoiceHistory<T extends { id: string }>(
  server: readonly T[],
  current: readonly T[],
  atRequestStart: readonly T[],
  limit = 100,
): T[] {
  const previous = new Map(atRequestStart.map((message) => [message.id, message]));
  const live = new Map(current.map((message) => [message.id, message]));
  const serverIds = new Set(server.map((message) => message.id));
  return [
    ...server.map((message) => {
      const updated = live.get(message.id);
      return updated && updated !== previous.get(message.id) ? updated : message;
    }),
    ...current.filter((message) => !previous.has(message.id) && !serverIds.has(message.id)),
  ].slice(-limit);
}
