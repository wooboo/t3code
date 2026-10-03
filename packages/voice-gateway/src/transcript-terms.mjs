/** Global term replacements applied to speech-to-text output before anything reads it. */
export function applyTranscriptTerms(text, terms) {
  if (!terms?.length || !text) return text;
  // Longest keys first so phrases beat their substrings.
  let result = text;
  for (const { from, to } of [...terms].sort((a, b) => b.from.length - a.from.length))
    result = result.replace(new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), to);
  return result;
}

/** STT wrapper: every transcript leaving the provider carries corrected names and spellings. */
export function rewritingSTT(Ctor, terms) {
  if (!terms?.length) return Ctor;
  return class extends Ctor {
    stream(options) {
      const inner = super.stream(options);
      const next = inner.next.bind(inner);
      inner.next = async (...args) => {
        const result = await next(...args);
        if (result.done || !result.value) return result;
        const event = result.value;
        if (!event?.alternatives?.length) return result;
        let changed = false;
        const alternatives = event.alternatives.map((alternative) => {
          const text = applyTranscriptTerms(alternative.text, terms);
          if (text === alternative.text) return alternative;
          changed = true;
          return { ...alternative, text };
        });
        return changed ? { ...result, value: { ...event, alternatives } } : result;
      };
      return inner;
    }
  };
}
