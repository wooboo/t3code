import { tokenize } from "@livekit/agents";

// LiveKit normally waits for the next sentence or end of LLM output. A voice
// acknowledgement must not wait for the tool arguments that follow it.
class VoiceSentenceStream extends tokenize.BufferedSentenceStream {
  timer;
  tail = "";

  pushText(text) {
    clearTimeout(this.timer);
    super.pushText(text);
    this.tail = (this.tail + text).slice(-128);
    const complete = /[.!?…][”"'»)\]]*\s*$/u.test(this.tail);
    const decimalOrAbbreviation = /(?:\d|\b(?:Dr|Mr|Ms|Mrs|Prof|np|itd|itp|m\.in))\.\s*$/iu.test(
      this.tail,
    );
    if (complete && !decimalOrAbbreviation) {
      // Allow punctuation split across adjacent deltas to settle. Never flush
      // unfinished text just because model generation pauses.
      this.timer = setTimeout(() => this.flush(), 150);
    }
  }

  flush() {
    clearTimeout(this.timer);
    this.tail = "";
    super.flush();
  }

  endInput() {
    clearTimeout(this.timer);
    super.endInput();
  }

  close() {
    clearTimeout(this.timer);
    super.close();
  }
}

export function createVoiceSentenceTokenizer() {
  const tokenizer = new tokenize.basic.SentenceTokenizer({ minSentenceLength: 1 });
  tokenizer.stream = () => new VoiceSentenceStream((text) => tokenizer.tokenize(text), 1, 1);
  return tokenizer;
}
