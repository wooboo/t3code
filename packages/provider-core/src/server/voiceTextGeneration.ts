import * as Schema from "effect/Schema";

// Provider structured-output dialects reject Effect's length-check `allOf`.
// Wire contracts still enforce limits; this generation schema keeps the portable subset.
const VoiceGenerationOutput = Schema.Struct({
  text: Schema.String,
  toolCalls: Schema.Array(Schema.Struct({ name: Schema.String, arguments: Schema.String })),
});

/** Tool requests are data for the coordinator, never instructions for CLI tools. */
export function buildVoiceResponsePrompt(prompt: string) {
  return {
    outputSchema: VoiceGenerationOutput,
    prompt: [
      "You are the conversational voice front, not the coding executor.",
      "Use only the supplied conversation. Do not use native tools, read or write files, run commands, or create agents.",
      'Return ONLY JSON with exactly these fields: {"text":"spoken reply","toolCalls":[{"name":"provided tool name","arguments":"JSON-encoded object"}]}.',
      "Only request tools explicitly supplied in the conversation. Return requests as JSON data; do not execute them.",
      "Use an empty toolCalls array for a normal reply. Never claim a requested action has completed before a tool result confirms it.",
      "Follow the conversation language and keep spoken replies concise.",
      "<conversation>",
      prompt,
      "</conversation>",
    ].join("\n"),
  };
}

// Disabling CLI tools must not depend on the user's ordinary coding settings.
// Auth still comes from the selected configured instance's CODEX_HOME.
export const CODEX_VOICE_ARGS = [
  "--ignore-user-config",
  "--ignore-rules",
  ...[
    "shell_tool",
    "unified_exec",
    "apps",
    "plugins",
    "hooks",
    "multi_agent",
    "multi_agent_v2",
    "browser_use",
    "computer_use",
    "in_app_browser",
    "image_generation",
    "view_image",
    "code_mode",
    "code_mode_host",
    "skill_search",
    "skill_mcp_dependency_install",
    "workspace_dependencies",
  ].flatMap((feature) => ["--config", `features.${feature}=false`]),
  "--config",
  'web_search="disabled"',
  "--config",
  "mcp_servers={}",
  "--config",
  "project_doc_max_bytes=0",
] as const;

export const CLAUDE_VOICE_ARGS = [
  "--tools",
  "",
  "--strict-mcp-config",
  "--mcp-config",
  '{"mcpServers":{}}',
  "--setting-sources",
  "",
  "--no-session-persistence",
] as const;
