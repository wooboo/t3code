import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { mountAgentSettings, readAgentSettings, saveAgentSettings } from "./agent-settings.mjs";
import { VoiceSettingsStore } from "../src/voice-settings.mjs";

NodeTest.test(
  "service settings survive reload, preserve credentials, and clear custom endpoints on preset switch",
  (t) => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "voice-config-"));
    t.after(() => NodeFS.rmSync(dir, { recursive: true, force: true }));
    const file = NodePath.join(dir, "config.env");
    NodeFS.writeFileSync(
      file,
      'VOICE_COMPARE_TTS_KEY="private-key"\nT3_VOICE_LLM_URL="http://localhost:8000/v1"\nVOICE_COMPARE_PUBLIC_ORIGIN="https://test.example"\n',
    );
    const input = {
      ...readAgentSettings({}),
      ttsVoice: "my-voice",
      silenceMs: 350,
      interruptions: false,
    };
    NodeAssert.deepEqual(saveAgentSettings(file, input), input);
    const saved = NodeUtil.parseEnv(NodeFS.readFileSync(file, "utf8"));
    NodeAssert.equal(saved.VOICE_COMPARE_TTS_KEY, "private-key");
    NodeAssert.equal(saved.VOICE_COMPARE_PUBLIC_ORIGIN, "https://test.example");
    NodeAssert.equal(saved.T3_VOICE_LLM_URL, undefined);
    NodeAssert.equal(saved.VOICE_COMPARE_TTS_URL, undefined);
    NodeAssert.equal(saved.VOICE_COMPARE_STT_URL, undefined);
    NodeAssert.deepEqual(readAgentSettings(saved), input);
    NodeAssert.ok(!JSON.stringify(readAgentSettings(saved)).includes("private-key"));
    const before = NodeFS.readFileSync(file, "utf8");
    for (const patch of [
      { silenceMs: 0 },
      { ttsUrl: "file:///tmp/x" },
      { ttsSampleRate: 48000 },
      { ttsVoice: "bad\nvalue" },
      { extra: true },
    ])
      NodeAssert.throws(() => saveAgentSettings(file, { ...input, ...patch }));
    NodeAssert.equal(NodeFS.readFileSync(file, "utf8"), before);
  },
);

NodeTest.test(
  "global instruction updates need no thread and preserve project and thread instructions",
  (t) => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "voice-global-"));
    t.after(() => NodeFS.rmSync(dir, { recursive: true, force: true }));
    const store = new VoiceSettingsStore(dir);
    store.update("owner", "/project", "thread", {
      instructions: { project: "Project", thread: "Thread" },
    });
    store.update("owner", "", "", { instructions: { global: "Global" } });
    NodeAssert.deepEqual(store.get("owner", "/project", "thread").instructions, {
      global: "Global",
      project: "Project",
      thread: "Thread",
    });
    NodeAssert.equal(store.read("owner").threads[""], undefined);
  },
);

NodeTest.test("custom API credentials persist privately and can be removed", (t) => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "voice-api-"));
  t.after(() => NodeFS.rmSync(dir, { recursive: true, force: true }));
  const file = NodePath.join(dir, "config.env");
  const config = {
    ...readAgentSettings({}),
    llmUrl: "http://localhost:1234/v1",
    llmApiType: "chat-completions",
  };
  const result = saveAgentSettings(file, { ...config, llmKey: "test-private-key" });
  NodeAssert.deepEqual(result, config);
  NodeAssert.equal(
    NodeUtil.parseEnv(NodeFS.readFileSync(file, "utf8")).T3_VOICE_LLM_KEY,
    "test-private-key",
  );
  NodeAssert.equal(NodeFS.statSync(file).mode & 0o777, 0o600);
  saveAgentSettings(file, { ...config, llmKey: "" });
  NodeAssert.equal(
    NodeUtil.parseEnv(NodeFS.readFileSync(file, "utf8")).T3_VOICE_LLM_KEY,
    undefined,
  );
  NodeAssert.throws(() => saveAgentSettings(file, { ...config, llmUrl: "" }), /API URL/);
});

NodeTest.test(
  "agent settings are readable without a compare config and explicit service writes stay unavailable",
  () => {
    const routes = new Map();
    const app = Object.fromEntries(
      ["get", "patch", "post"].map((method) => [
        method,
        (path, handler) => routes.set(`${method}:${path}`, handler),
      ]),
    );
    mountAgentSettings(app, { T3_VOICE_LLM_KEY: "secret", T3_VOICE_LLM_MODEL: "configured-model" });
    let body;
    let status = 200;
    const response = {
      json: (value) => {
        body = value;
      },
      status: (code) => {
        status = code;
        return response;
      },
    };
    routes.get("get:/agent-settings")({}, response);
    NodeAssert.equal(status, 200);
    NodeAssert.equal(body.config.llmModel, "configured-model");
    NodeAssert.equal(body.writable, false);
    NodeAssert.equal(body.restartRequired, false);
    NodeAssert.equal(JSON.stringify(body).includes("secret"), false);
    routes.get("patch:/agent-settings")({ body: readAgentSettings({}) }, response);
    NodeAssert.equal(status, 503);
  },
);

NodeTest.test(
  "service settings support VOICE_CONFIG_FILE independently of the compare launcher",
  (t) => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "voice-config-"));
    t.after(() => NodeFS.rmSync(dir, { recursive: true, force: true }));
    const routes = new Map();
    const app = Object.fromEntries(
      ["get", "patch", "post"].map((method) => [
        method,
        (path, handler) => routes.set(`${method}:${path}`, handler),
      ]),
    );
    mountAgentSettings(app, { VOICE_CONFIG_FILE: NodePath.join(dir, "voice.env") });
    let body;
    routes.get("patch:/agent-settings")(
      { body: { ...readAgentSettings({}), silenceMs: 700 } },
      {
        json: (value) => {
          body = value;
        },
      },
    );
    NodeAssert.equal(body.writable, true);
    NodeAssert.equal(body.config.silenceMs, 700);
  },
);
