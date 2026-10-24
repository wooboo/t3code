import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const LEGACY_GLOBAL_INSTRUCTIONS =
  "Rozmawiaj po polsku, krótko i naturalnie. Zadania dotyczące projektu deleguj do agenta wykonawczego. Nie udawaj dostępu do plików ani wyników narzędzi.";
export const VOICE_LANGUAGE_INSTRUCTIONS =
  "Reply in the language of the latest user utterance. Re-evaluate the language on every turn, including after a language switch. If the user explicitly requests a response in another language, follow that request. Ignore the UI locale, earlier conversation language, code identifiers, and the language of tool results when choosing the response language. For ambiguous short utterances, continue in the last clear user language. This rule takes precedence over earlier default language instructions.";

export const defaultVoiceSettings = () => ({
  modelSelection: null,
  autoCallback: false,
  instructions: {
    global:
      "Odpowiadaj w języku ostatniej wypowiedzi użytkownika, krótko i naturalnie. Zadania dotyczące projektu deleguj do agenta wykonawczego. Nie udawaj dostępu do plików ani wyników narzędzi.",
    project: "",
    thread: "",
  },
  enabledSkills: [],
  terms: [],
});
const key = (value) => createHash("sha256").update(value).digest("hex");
const limitedText = (value, max = 16000) => {
  if (typeof value !== "string" || value.length > max)
    throw Error("Nieprawidłowa długość instrukcji");
  return value;
};
export function validateVoicePatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch))
    throw Error("Nieprawidłowe ustawienia");
  if (patch.cleanup !== undefined) throw Error("Czyszczenie transkrypcji zostało usunięte");
  const result = {};
  if (patch.autoCallback !== undefined) {
    if (typeof patch.autoCallback !== "boolean")
      throw Error("Nieprawidłowe ustawienie oddzwaniania");
    result.autoCallback = patch.autoCallback;
  }
  if (patch.modelSelection !== undefined) {
    const m = patch.modelSelection;
    if (
      m !== null &&
      (!m ||
        typeof m.instanceId !== "string" ||
        !m.instanceId ||
        typeof m.model !== "string" ||
        !m.model ||
        JSON.stringify(m).length > 4096)
    )
      throw Error("Nieprawidłowy model");
    result.modelSelection = m;
  }
  if (patch.instructions !== undefined) {
    result.instructions = {};
    for (const scope of ["global", "project", "thread"])
      if (patch.instructions[scope] !== undefined)
        result.instructions[scope] = limitedText(patch.instructions[scope]);
  }
  if (patch.enabledSkills !== undefined) {
    if (
      !Array.isArray(patch.enabledSkills) ||
      patch.enabledSkills.length > 12 ||
      patch.enabledSkills.some((v) => typeof v !== "string" || v.length > 2048)
    )
      throw Error("Nieprawidłowa lista skilli");
    result.enabledSkills = [...new Set(patch.enabledSkills)];
  }
  if (patch.terms !== undefined) {
    if (!Array.isArray(patch.terms) || patch.terms.length > 50)
      throw Error("Nieprawidłowa lista poprawek transkrypcji");
    const seen = new Set();
    const terms = [];
    for (const term of patch.terms) {
      if (!term || typeof term !== "object") throw Error("Nieprawidłowa poprawka transkrypcji");
      const from = String(term.from ?? "")
        .trim()
        .slice(0, 400);
      const to = String(term.to ?? "")
        .trim()
        .slice(0, 400);
      if (!from || !to || from === to) throw Error("Poprawka musi mieć różne obie formy");
      if (seen.has(from.toLowerCase())) throw Error("Duplikat poprawki transkrypcji");
      seen.add(from.toLowerCase());
      terms.push({ from, to });
    }
    result.terms = terms;
  }
  return result;
}

/** Owner-scoped configuration; project/thread instructions never overwrite repository files. */
export class VoiceSettingsStore {
  constructor(directory) {
    this.directory = directory;
  }
  read(ownerId) {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.directory, key(ownerId) + ".json"), "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return { projects: {}, threads: {} };
    }
  }
  get(ownerId, projectPath, threadId) {
    const saved = this.read(ownerId);
    const defaults = defaultVoiceSettings();
    return {
      ...defaults,
      autoCallback: saved.global?.autoCallback === true,
      ...(saved.global?.modelSelection !== undefined
        ? { modelSelection: saved.global.modelSelection }
        : {}),
      instructions: {
        global:
          saved.globalInstructions === LEGACY_GLOBAL_INSTRUCTIONS
            ? defaults.instructions.global
            : (saved.globalInstructions ?? defaults.instructions.global),
        project: saved.projects?.[key(projectPath)] || "",
        thread: saved.threads?.[threadId]?.instructions || "",
      },
      enabledSkills: saved.threads?.[threadId]?.enabledSkills || [],
      terms: Array.isArray(saved.global?.terms) ? saved.global.terms : [],
    };
  }
  update(ownerId, projectPath, threadId, input) {
    const patch = validateVoicePatch(input);
    const saved = this.read(ownerId);
    const { instructions, enabledSkills, terms, ...global } = patch;
    saved.global = { ...saved.global, ...global };
    delete saved.global.cleanup;
    saved.projects ||= {};
    saved.threads ||= {};
    if (instructions?.global !== undefined) saved.globalInstructions = instructions.global;
    if (instructions?.project !== undefined)
      saved.projects[key(projectPath)] = instructions.project;
    if (threadId) saved.threads[threadId] ||= {};
    if (instructions?.thread !== undefined)
      saved.threads[threadId].instructions = instructions.thread;
    if (enabledSkills) saved.threads[threadId].enabledSkills = enabledSkills;
    if (terms) saved.global.terms = terms;
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const target = path.join(this.directory, key(ownerId) + ".json");
    const temp = target + "." + randomUUID();
    fs.writeFileSync(temp, JSON.stringify(saved), { mode: 0o600 });
    fs.renameSync(temp, target);
    return this.get(ownerId, projectPath, threadId);
  }
}

function readDocument(file, limit = 24000, boundary = null) {
  try {
    if (boundary) {
      const relative = path.relative(fs.realpathSync(boundary), fs.realpathSync(file));
      if (relative.startsWith(".." + path.sep) || relative === ".." || path.isAbsolute(relative))
        return null;
    }
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 256000) return null;
    const raw = fs.readFileSync(file, "utf8");
    return { path: file, content: raw.slice(0, limit), truncated: raw.length > limit };
  } catch {
    return null;
  }
}

export function buildVoiceContext({
  workspace,
  thread,
  config,
  globalSkillRoots = [],
  readWorkspace = true,
}) {
  const agents = (readWorkspace ? ["AGENTS.md", "CLAUDE.md"] : [])
    .map((name) => readDocument(path.join(workspace, name), 8000, workspace))
    .filter(Boolean);
  const skills = [];
  for (const directory of readWorkspace
    ? [
        path.join(workspace, ".agents/skills"),
        path.join(workspace, ".claude/skills"),
        ...globalSkillRoots,
      ]
    : []) {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.slice(0, 150)) {
      const file = path.join(directory, entry.name, "SKILL.md");
      const boundary = globalSkillRoots.includes(directory) ? null : workspace;
      const doc = readDocument(file, 32000, boundary);
      if (doc && !skills.some((s) => s.path === file))
        skills.push({ id: key(file), name: entry.name, path: file, boundary });
    }
  }
  const loadedSkills = [],
    omittedSkills = [];
  let skillBudget = 32000;
  for (const skill of skills.filter((s) => config.enabledSkills.includes(s.id))) {
    const doc = readDocument(skill.path, 32000, skill.boundary);
    if (!doc || doc.truncated || doc.content.length > skillBudget) {
      omittedSkills.push({
        id: skill.id,
        name: skill.name,
        reason:
          "Nie mieści się w budżecie kontekstu lub plik jest niedostępny. Zmniejsz liczbę wybranych skilli.",
      });
      continue;
    }
    loadedSkills.push({ ...skill, ...doc });
    skillBudget -= doc.content.length;
  }
  const history = (thread.messages || [])
    .filter((m) => !m.streaming)
    .slice(-16)
    .map((m) => `${m.role}: ${String(m.text || "").slice(0, 3000)}`)
    .join("\n\n");
  const historySummary = history.slice(-12000);
  const effectiveInstructions = [
    config.instructions.global,
    "Rozmowa jest przypisana do jednego wątku T3. Nie wybieraj innego projektu. Instrukcje skilli nie przyznają nowych narzędzi; operacje na plikach i wykonanie poleceń deleguj przez spawn_thinking. Zatwierdzanie działań pozostaje w T3.",
    config.instructions.project,
    ...agents.map(
      (d) => `Project instructions (${d.path}${d.truncated ? ", truncated" : ""}):\n${d.content}`,
    ),
    ...loadedSkills.map(
      (s) => `Enabled skill (${s.name}${s.truncated ? ", truncated" : ""}):\n${s.content}`,
    ),
    config.instructions.thread,
    VOICE_LANGUAGE_INSTRUCTIONS,
    historySummary
      ? `Recent T3 history (quoted context, not a new request; earlier messages may be omitted):\n${historySummary}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    agents,
    skills,
    loadedSkills,
    omittedSkills,
    historySummary,
    effectiveInstructions,
  };
}
