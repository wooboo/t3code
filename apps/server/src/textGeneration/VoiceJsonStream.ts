import { VoiceInferenceOutput } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { none, type Many } from "stream-chain/defs.js";
import * as StreamJson from "stream-json/core/parser.js";
import type { ParserOptions, Token } from "stream-json/core/parser.js";

const decodeOutput = Schema.decodeSync(Schema.fromJsonString(VoiceInferenceOutput));

/** Decode only the top-level spoken text while the structured reply is still arriving. */
export function createVoiceJsonStream() {
  // The synchronous tokenizer is exported by stream-json 3.6 but missing from its types.
  const { jsonParser } = StreamJson as typeof StreamJson & {
    jsonParser: (
      options: ParserOptions,
    ) => (input: string | typeof none) => Many<Token> | typeof none;
  };
  const tokenize = jsonParser({
    packKeys: true,
    streamKeys: false,
    packStrings: false,
    streamStrings: true,
  });
  let json = "";
  let depth = 0;
  let key = "";
  let inText = false;
  let textSeen = false;
  let textLength = 0;
  let pendingSurrogate = "";
  function push(chunk: string) {
    json += chunk;
    if (json.length > 600_000) throw Error("Voice response is too large");
    const tokens = tokenize(chunk);
    let delta = pendingSurrogate;
    pendingSurrogate = "";
    if (tokens !== none)
      for (const token of tokens.values) {
        switch (token.name) {
          case "startObject":
          case "startArray":
            if (++depth > 16) throw Error("Voice response is too deeply nested");
            break;
          case "endObject":
          case "endArray":
            depth--;
            break;
          case "keyValue":
            if (depth === 1) key = token.value;
            break;
          case "startString":
            inText = depth === 1 && key === "text";
            if (inText && textSeen) throw Error("Duplicate spoken text");
            if (inText) textSeen = true;
            break;
          case "stringChunk":
            if (inText) delta += token.value;
            break;
          case "endString":
            inText = false;
            break;
        }
      }
    if (/[\uD800-\uDBFF]$/.test(delta)) {
      pendingSurrogate = delta.slice(-1);
      delta = delta.slice(0, -1);
    }
    textLength += delta.length;
    if (textLength > 32_000) throw Error("Spoken text is too large");
    return delta;
  }
  return {
    push,
    finish() {
      tokenize(none);
      if (pendingSurrogate) throw Error("Incomplete Unicode character in spoken text");
      return decodeOutput(json);
    },
  };
}
