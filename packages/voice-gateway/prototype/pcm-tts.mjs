import { createVoiceSentenceTokenizer } from "./voice-sentence-tokenizer.mjs";
import * as NodeCrypto from "node:crypto";
import { AudioByteStream, tts } from "@livekit/agents";

// Our existing ElevenLabs bridge streams 16 kHz PCM. The stock OpenAI plugin
// assumes 24 kHz and buffers whole responses; preserve the real rate and chunks.
export class PcmTTS extends tts.TTS {
  label = "t3.prototype.PcmTTS";
  constructor(options) {
    super(options.sampleRate, 1, { streaming: true, alignedTranscript: true });
    this.options = options;
    this.abort = new AbortController();
  }
  get model() {
    return this.options.model;
  }
  get provider() {
    return new URL(this.options.baseURL).host;
  }
  synthesize(text, connOptions, abortSignal) {
    return new PcmStream(
      text,
      this,
      connOptions,
      AbortSignal.any([this.abort.signal, ...(abortSignal ? [abortSignal] : [])]),
    );
  }
  stream(options) {
    return new tts.StreamAdapterWrapper(this, createVoiceSentenceTokenizer(), options?.connOptions);
  }
  async close() {
    this.abort.abort();
  }
}

class PcmStream extends tts.ChunkedStream {
  label = "t3.prototype.PcmStream";
  constructor(text, owner, connOptions, signal) {
    super(text, owner, connOptions, signal);
    this.options = owner.options;
    this.text = text;
    this.requestSignal = signal;
  }
  async run() {
    try {
      await this.synthesizeAudio();
    } catch (error) {
      // Interruptions and hangups cancel HTTP synthesis without failing the call.
      // Keep endpoint failures and request timeouts visible to the session.
      const cancelled = [this.requestSignal, this.abortController.signal].some(
        (signal) => signal.aborted && error === signal.reason,
      );
      if (!cancelled) throw error;
    } finally {
      this.queue.close();
    }
  }
  async synthesizeAudio() {
    const response = await fetch(`${this.options.baseURL.replace(/\/$/, "")}/audio/speech`, {
      method: "POST",
      signal: AbortSignal.any([
        this.requestSignal,
        this.abortController.signal,
        AbortSignal.timeout(120000),
      ]),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.options.apiKey}`,
      },
      body: JSON.stringify({
        input: this.text,
        model: this.options.model,
        voice: this.options.voice,
        response_format: "pcm",
      }),
    });
    if (!response.ok || !response.body) throw Error(`TTS HTTP ${response.status}`);
    const requestId = NodeCrypto.randomUUID();
    const pcm = new AudioByteStream(this.options.sampleRate, 1);
    let last;
    const emit = (frame) => {
      if (last) this.queue.put({ requestId, segmentId: requestId, frame: last, final: false });
      last = frame;
    };
    try {
      for await (const bytes of response.body) {
        for (const frame of pcm.write(
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        ))
          emit(frame);
      }
      for (const frame of pcm.flush()) emit(frame);
      if (last) this.queue.put({ requestId, segmentId: requestId, frame: last, final: true });
    } finally {
      this.queue.close();
    }
  }
}
