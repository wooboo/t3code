import { describe, expect, it } from "vite-plus/test";
import {
  buildVoiceResponsePrompt,
  CLAUDE_VOICE_ARGS,
  CODEX_VOICE_ARGS,
} from "./VoiceTextGeneration.ts";
import { toJsonSchemaObject } from "@t3tools/provider-core/server/textGenerationUtils";

describe("voice structured generation", () => {
  it("uses the provider-supported JSON Schema subset, not allOf length constraints", () => {
    const { outputSchema, prompt } = buildVoiceResponsePrompt("Hello");
    expect(JSON.stringify(toJsonSchemaObject(outputSchema))).not.toContain("allOf");
    expect(prompt).toContain("not the coding executor");
    expect(prompt).toContain("do not execute them");
  });

  it("does not inherit hooks, plugins, native tools or permissions bypass", () => {
    expect(CODEX_VOICE_ARGS).toContain("--ignore-user-config");
    expect(CODEX_VOICE_ARGS).toContain("features.shell_tool=false");
    expect(CODEX_VOICE_ARGS).toContain("features.plugins=false");
    expect(CLAUDE_VOICE_ARGS).not.toContain("--dangerously-skip-permissions");
    expect(CLAUDE_VOICE_ARGS[CLAUDE_VOICE_ARGS.indexOf("--tools") + 1]).toBe("");
  });
});
