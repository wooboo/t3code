import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { VoiceSettingsStore, buildVoiceContext, validateVoicePatch } from "./voice-settings.mjs";
import { decodeVoiceModel, responseEnvelope } from "./llm-bridge.mjs";

test("settings preserve owner/project/thread scope and reject removed cleanup", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-settings-test-"));
  try {
    const store = new VoiceSettingsStore(root);
    store.update("a", "/one", "one", {
      instructions: { project: "Project A", thread: "Thread one" },
    });
    assert.equal(store.get("a", "/one", "two").instructions.project, "Project A");
    assert.equal(store.get("a", "/two", "two").instructions.project, "");
    assert.equal(store.get("a", "/one", "two").instructions.thread, "");
    assert.equal(store.get("b", "/one", "one").instructions.project, "");
    store.read = () => ({ global: { cleanup: { mode: "before-agent", model: "old" } } });
    assert.equal("cleanup" in store.get("a", "/one", "one"), false);
    assert.throws(() =>
      validateVoicePatch({ cleanup: { mode: "before-agent", model: "m", timeoutMs: -1 } }),
    );
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("transcript term map persists globally and round-trips into calls", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-terms-test-"));
  try {
    const store = new VoiceSettingsStore(root);
    assert.deepEqual(store.get("a", "/one", "one").terms, []);
    store.update("a", "/one", "one", { terms: [{ from: "kioxia", to: "KIOXIA" }] });
    assert.deepEqual(store.get("a", "/one", "one").terms, [{ from: "kioxia", to: "KIOXIA" }]);
    store.update("a", "/two", "two", { terms: [] });
    assert.deepEqual(store.get("a", "/one", "one").terms, []);
    assert.throws(() => validateVoicePatch({ terms: [{ from: "x", to: "" }] }));
    assert.throws(() => validateVoicePatch({ terms: [{ from: "x", to: "x" }] }));
    assert.throws(() =>
      validateVoicePatch({
        terms: [
          { from: "a", to: "b" },
          { from: "A", to: "c" },
        ],
      }),
    );
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("context loads only explicitly selected skills and preserves instructions/history", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-context-test-"));
  try {
    fs.mkdirSync(path.join(root, ".agents/skills/example"), { recursive: true });
    fs.writeFileSync(path.join(root, ".agents/skills/example/SKILL.md"), "Test skill instructions");
    fs.writeFileSync(path.join(root, "AGENTS.md"), "Project instructions");
    const store = new VoiceSettingsStore(path.join(root, "state"));
    const config = store.get("a", root, "one");
    const first = buildVoiceContext({
      workspace: root,
      config,
      thread: { messages: [{ role: "user", text: "Previous task" }] },
    });
    assert.equal(first.loadedSkills.length, 0);
    assert.match(first.effectiveInstructions, /Previous task/);
    const selected = buildVoiceContext({
      workspace: root,
      config: { ...config, enabledSkills: [first.skills[0].id] },
      thread: {},
    });
    assert.match(selected.effectiveInstructions, /Test skill instructions/);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("model routing preserves native instance/options and rejects undeclared tools", () => {
  const selection = { instanceId: "codex", model: "test", options: { reasoningEffort: "low" } };
  assert.deepEqual(
    decodeVoiceModel("t3:" + Buffer.from(JSON.stringify(selection)).toString("base64url")),
    { selection },
  );
  assert.deepEqual(decodeVoiceModel("direct:gpt-5.6-luna"), { direct: "gpt-5.6-luna" });
  assert.throws(() =>
    responseEnvelope({ toolCalls: [{ name: "shell", arguments: "{}" }] }, "test", []),
  );
  assert.equal(
    responseEnvelope({ text: "OK", toolCalls: [] }, "test").output[0].content[0].text,
    "OK",
  );
});

test("project instructions cannot follow a symlink outside the workspace", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-boundary-test-"));
  try {
    const workspace = path.join(root, "project");
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(root, "private.txt"), "PRIVATE TEST SENTINEL");
    fs.symlinkSync(path.join(root, "private.txt"), path.join(workspace, "AGENTS.md"));
    const config = new VoiceSettingsStore(path.join(root, "state")).get("a", workspace, "one");
    const context = buildVoiceContext({ workspace, config, thread: {} });
    assert.equal(context.agents.length, 0);
    assert.doesNotMatch(context.effectiveInstructions, /PRIVATE TEST SENTINEL/);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("large skills are explicitly omitted without dropping thread instructions or history", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-budget-test-"));
  try {
    fs.mkdirSync(path.join(root, ".agents/skills/large"), { recursive: true });
    fs.writeFileSync(path.join(root, ".agents/skills/large/SKILL.md"), "x".repeat(40000));
    const config = new VoiceSettingsStore(path.join(root, "state")).get("a", root, "one");
    const first = buildVoiceContext({ workspace: root, config, thread: {} });
    config.enabledSkills = [first.skills[0].id];
    config.instructions.thread = "CURRENT THREAD INSTRUCTIONS";
    const context = buildVoiceContext({
      workspace: root,
      config,
      thread: { messages: [{ role: "user", text: "RECENT HISTORY" }] },
    });
    assert.equal(context.loadedSkills.length, 0);
    assert.equal(context.omittedSkills.length, 1);
    assert.match(context.effectiveInstructions, /CURRENT THREAD INSTRUCTIONS/);
    assert.match(context.effectiveInstructions, /RECENT HISTORY/);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("legacy Polish default migrates while custom voice instructions are preserved", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-language-test-"));
  try {
    const store = new VoiceSettingsStore(root);
    store.update("a", "/project", "thread", {
      instructions: {
        global:
          "Rozmawiaj po polsku, krótko i naturalnie. Zadania dotyczące projektu deleguj do agenta wykonawczego. Nie udawaj dostępu do plików ani wyników narzędzi.",
      },
    });
    const migrated = store.get("a", "/project", "thread");
    assert.match(migrated.instructions.global, /języku ostatniej wypowiedzi/);
    store.update("a", "/project", "thread", { instructions: { global: "Use concise sentences." } });
    assert.equal(
      store.get("a", "/project", "thread").instructions.global,
      "Use concise sentences.",
    );
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});
