import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { replaceFileSync, withFileTransaction } from "../../../shared/file-transaction-lock.mjs";

const MAX_EDIT_ITEMS = 20;

function text(value) {
  return String(value || "")
    .replaceAll("\0", "")
    .replace(/\r\n?/g, "\n");
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function publicDocument(scope, content, revisionSource = content) {
  return {
    id: `${scope}_document`,
    scope,
    content,
    format: "markdown",
    revision: digest(revisionSource),
    editable: true,
  };
}

function countOccurrences(content, needle) {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = content.indexOf(needle, offset)) >= 0) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function normalizeMarkdown(content) {
  const lines = text(content).split("\n");
  const seenBullets = new Set();
  return lines
    .filter((line) => !/^\s*[-*+]\s*$/.test(line))
    .filter((line) => {
      const match = line.match(/^\s*[-*+]\s+(.+?)\s*$/);
      if (!match) return true;
      const item = match[1].replace(/\s+/g, " ").trim();
      if (seenBullets.has(item)) return false;
      seenBullets.add(item);
      return true;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

export class MarkdownContextStore {
  constructor({
    filePath,
    scope,
    personalOwnerId = "user_personal",
    maxChars = 8000,
    template = "",
    onWarning = (warning) => console.warn(warning.message),
  } = {}) {
    this.filePath = filePath;
    this.scope = scope;
    this.personalOwnerId = String(personalOwnerId);
    this.maxChars = maxChars;
    this.template = text(template).trimEnd();
    this.onWarning = onWarning;
    this.warning = null;
  }

  pathFor(ownerId) {
    if (!this.filePath) return null;
    const owner = String(ownerId || this.personalOwnerId);
    if (owner === this.personalOwnerId) return this.filePath;
    return join(dirname(this.filePath), "users", digest(owner), basename(this.filePath));
  }

  read(ownerId) {
    const content = this.readRaw(ownerId);
    if ([...content].length <= this.maxChars) return content;
    return `${[...content].slice(0, this.maxChars).join("")}\n\n<!-- 内容过长，已截断；精确编辑前请缩小文档 -->`;
  }

  readRaw(ownerId) {
    const path = this.pathFor(ownerId);
    if (!path) return "";
    try {
      const content = text(readFileSync(path, "utf8")).trim();
      this.warning = null;
      return content;
    } catch (error) {
      if (error.code === "ENOENT") return "";
      this.warn(`无法读取 ${basename(path)}：${error.message}`);
      return "";
    }
  }

  list(ownerId) {
    const raw = this.readRaw(ownerId);
    if (!raw) return [];
    const content =
      [...raw].length <= this.maxChars
        ? raw
        : `${[...raw].slice(0, this.maxChars).join("")}\n\n<!-- 内容过长，已截断；精确编辑前请缩小文档 -->`;
    return [publicDocument(this.scope, content, raw)];
  }

  edit(ownerId, { edits = [], append = "", expectedRevision = "" } = {}) {
    const path = this.pathFor(ownerId);
    return withFileTransaction(path, () => {
      const prepared = this.prepareEdit(ownerId, { edits, append, expectedRevision });
      if (!prepared.changed) {
        return { changed: 0, document: prepared.document };
      }
      this.persist(ownerId, `${prepared.content}\n`);
      return { changed: prepared.changed, document: prepared.document };
    });
  }

  prepareEdit(ownerId, { edits = [], append = "", expectedRevision = "" } = {}) {
    const current = this.readRaw(ownerId) || this.template;
    if (expectedRevision && expectedRevision !== digest(current)) {
      const error = new Error("memory document changed; read it again before editing");
      error.code = "stale_document";
      throw error;
    }
    const operations = Array.isArray(edits) ? edits.slice(0, MAX_EDIT_ITEMS) : [];
    let next = current;
    let changed = 0;
    for (const operation of operations) {
      const oldText = text(operation?.old_text);
      const newText = text(operation?.new_text);
      if (!oldText) {
        const error = new Error("old_text is required for an exact edit");
        error.code = "invalid_edit";
        throw error;
      }
      const matches = countOccurrences(next, oldText);
      if (matches !== 1) {
        const error = new Error(
          matches ? "old_text must match exactly once" : "old_text was not found",
        );
        error.code = matches ? "ambiguous_edit" : "edit_not_found";
        throw error;
      }
      next = next.replace(oldText, newText);
      changed += 1;
    }
    const addition = text(append).trim();
    if (addition) {
      next = `${next.trimEnd()}\n\n${addition}\n`;
      changed += 1;
    }
    next = normalizeMarkdown(next);
    if (!changed || next === current.trimEnd()) {
      return {
        changed: 0,
        content: current.trimEnd(),
        document: publicDocument(this.scope, current),
      };
    }
    if ([...next].length > this.maxChars) {
      const error = new Error(`${basename(this.filePath)} 最多保存 ${this.maxChars} 个字符`);
      error.code = "document_too_large";
      throw error;
    }
    return {
      changed,
      content: next,
      document: publicDocument(this.scope, next),
    };
  }

  persist(ownerId, content) {
    const path = this.pathFor(ownerId);
    if (!path) throw new Error("memory document is unavailable");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
    replaceFileSync(temporary, path);
    chmodSync(path, 0o600);
    this.warning = null;
  }

  warn(message) {
    this.warning = { message, at: Date.now() };
    try {
      this.onWarning?.(this.warning);
    } catch {
      // Diagnostics must not break the voice service.
    }
  }

  health() {
    return {
      ok: !this.warning,
      configured: Boolean(this.filePath),
      warning: this.warning,
    };
  }
}
