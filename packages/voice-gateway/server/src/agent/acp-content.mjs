import { inputFileParts, parseDataUrl } from "../../../shared/input-parts.mjs";

function resourceUri(part, index) {
  const filename = String(part.filename || `attachment-${index + 1}`);
  return `qwen-audio-agent://input/${encodeURIComponent(filename)}`;
}

function isTextMime(mime) {
  return (
    mime.startsWith("text/") ||
    [
      "application/json",
      "application/javascript",
      "application/xml",
      "application/yaml",
      "application/x-yaml",
    ].includes(mime)
  );
}

function decodeUtf8(data) {
  return Buffer.from(data, "base64").toString("utf8");
}

export function inputPartsToAcpBlocks(parts = []) {
  return inputFileParts(parts).map((part, index) => {
    const embedded = parseDataUrl(part.url);
    if (!embedded) {
      return {
        type: "resource_link",
        uri: part.url,
        name: part.filename || `attachment-${index + 1}`,
        mimeType: part.mime,
      };
    }
    if (part.mime.startsWith("image/")) {
      return {
        type: "image",
        mimeType: part.mime,
        data: embedded.data,
        uri: resourceUri(part, index),
      };
    }
    if (part.mime.startsWith("audio/")) {
      return {
        type: "audio",
        mimeType: part.mime,
        data: embedded.data,
      };
    }
    return {
      type: "resource",
      resource: isTextMime(part.mime)
        ? {
            uri: resourceUri(part, index),
            mimeType: part.mime,
            text: decodeUtf8(embedded.data),
          }
        : {
            uri: resourceUri(part, index),
            mimeType: part.mime,
            blob: embedded.data,
          },
    };
  });
}

export function promptWithInputParts(text, parts = []) {
  const attachments = inputPartsToAcpBlocks(parts);
  if (!attachments.length) return String(text || "");
  return [{ type: "text", text: String(text || "") }, ...attachments];
}

export function normalizeAcpPrompt(prompt) {
  if (!Array.isArray(prompt)) {
    return [{ type: "text", text: String(prompt || "") }];
  }
  if (!prompt.length) throw new Error("ACP Prompt 不能为空");
  return prompt.map((block) => {
    if (!block || typeof block !== "object" || !block.type) {
      throw new Error("ACP Prompt 包含无效的 ContentBlock");
    }
    return block;
  });
}

export function assertPromptCapabilities(blocks, capabilities = {}) {
  const prompt = capabilities.promptCapabilities || {};
  for (const block of blocks) {
    if (block.type === "image" && prompt.image !== true) {
      throw new Error("当前后台 Agent 未声明 ACP 图片输入能力");
    }
    if (block.type === "audio" && prompt.audio !== true) {
      throw new Error("当前后台 Agent 未声明 ACP 音频输入能力");
    }
    if (block.type === "resource" && prompt.embeddedContext !== true) {
      throw new Error("当前后台 Agent 未声明 ACP 内嵌文件能力");
    }
  }
}

export function transformPromptText(prompt, transform) {
  if (!Array.isArray(prompt)) return transform(String(prompt || ""));
  let transformed = false;
  const blocks = prompt.map((block) => {
    if (!transformed && block?.type === "text") {
      transformed = true;
      return { ...block, text: transform(String(block.text || "")) };
    }
    return block;
  });
  if (!transformed) blocks.unshift({ type: "text", text: transform("") });
  return blocks;
}

export function nonTextPromptBlocks(prompt) {
  return Array.isArray(prompt) ? prompt.filter((block) => block?.type !== "text") : [];
}

export function appendPromptBlocks(prompt, blocks = []) {
  if (!blocks.length) return prompt;
  const normalized = normalizeAcpPrompt(prompt);
  return [...normalized, ...blocks];
}
