import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SandboxMode } from "./types.js";
import { sandboxModes } from "./types.js";
import { buildSystemPrompt } from "./prompt.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function getWorkdir(): string {
  return process.env.CODEX_WORKDIR || process.cwd();
}

export function getDataDir(): string {
  return process.env.DATA_DIR || process.env.CODEX_DATA_DIR || path.resolve(__dirname, "../.data");
}

export function getSandbox(): SandboxMode {
  const sandboxRaw = process.env.CODEX_SANDBOX || "read-only";
  if (!sandboxModes.includes(sandboxRaw as SandboxMode)) {
    return "read-only";
  }
  return sandboxRaw as SandboxMode;
}

function getSystemPrompt(): string {
  return buildSystemPrompt({
    workdir: getWorkdir(),
    sandbox: getSandbox(),
    extraPrompt: process.env.CODEX_SYSTEM_PROMPT,
  });
}

function buildOutputContract(source: string): string {
  return [
    `当前消息来自：${source}客户端`,
    "只回复当前这条用户消息。",
    "如果需要发送图片给用户，在回复中包含图片绝对路径或 Markdown 图片语法 ![描述](/绝对路径.png)。相对路径基于工作目录解析。",
    "如果需要发送非图片文件，每个文件单独一行，格式：FILE: /绝对路径/文件名.扩展名。",
  ].join("\n");
}

export function buildFirstTurnPrompt(userText: string, source: string = "web"): string {
  return `${getSystemPrompt()}

输出要求：
${buildOutputContract(source)}

用户消息：
${userText}`;
}

export function buildResumePrompt(userText: string, source: string = "web"): string {
  return `${userText}

补充要求：
${buildOutputContract(source)}`;
}

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function generateTitle(text: string): string {
  const clean = text.replace(/\n/g, " ").trim();
  return clean.length > 20 ? clean.slice(0, 20) + "…" : clean;
}

export function getProviderTimeoutMs(): number {
  return parseInt(process.env.PROVIDER_TIMEOUT_MS || "600000", 10);
}
