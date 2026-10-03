import { describe, expect, it } from "vite-plus/test";
import { createVoiceJsonStream } from "./VoiceJsonStream.ts";

describe("voice JSON streaming", () => {
  it("emits spoken text before the tool envelope is complete", () => {
    const parser = createVoiceJsonStream();
    expect(parser.push('{"text":"Już sprawdzam.')).toBe("Już sprawdzam.");
    expect(parser.push('","toolCalls":[{"name":"delegate","arguments":"{}"}]}')).toBe("");
    expect(parser.finish()).toEqual({
      text: "Już sprawdzam.",
      toolCalls: [{ name: "delegate", arguments: "{}" }],
    });
  });
  it("decodes escaping across every chunk boundary without speaking nested fields", () => {
    const text = 'Cześć! "Test"\n\\ 😀';
    const json = JSON.stringify({
      toolCalls: [{ name: "tool", arguments: '{"text":"hidden"}' }],
      text,
    }).replace("😀", "\\ud83d\\ude00");
    for (let split = 1; split < json.length; split++) {
      const parser = createVoiceJsonStream();
      expect(parser.push(json.slice(0, split)) + parser.push(json.slice(split))).toBe(text);
      expect(parser.finish().text).toBe(text);
    }
  });
  it("rejects truncated, duplicate and oversized replies", () => {
    const truncated = createVoiceJsonStream();
    truncated.push('{"text":"Hi');
    expect(() => truncated.finish()).toThrow();
    expect(() => createVoiceJsonStream().push('{"text":"Hi","text":"Bye"}')).toThrow();
    expect(() => createVoiceJsonStream().push('{"text":"' + "x".repeat(32_001))).toThrow();
  });
});
