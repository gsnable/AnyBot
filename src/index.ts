import "dotenv/config";

import * as Lark from "@larksuiteoapi/node-sdk";
import { spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildSystemPrompt } from "./prompt.js";

type ChatRole = "user" | "assistant";

type ChatTurn = {
  role: ChatRole;
  content: string;
};

type TextMessageContent = {
  text?: string;
};

type ImageMessageContent = {
  image_key?: string;
};

type IncomingMessage = {
  message_id: string;
  chat_id: string;
  message_type: string;
  content: string;
};

type ReplyPayload = {
  text: string;
  imagePaths: string[];
};

const sandboxModes = [
  "read-only",
  "workspace-write",
  "danger-full-access",
] as const;

type SandboxMode = (typeof sandboxModes)[number];

type CodexJsonEvent = {
  type?: string;
  thread_id?: string;
  item?: {
    type?: string;
    text?: string;
  };
};

const requiredEnv = [
  "FEISHU_APP_ID",
  "FEISHU_APP_SECRET",
] as const;

for (const key of requiredEnv) {
  if (!process.env[key]) {
    throw new Error(`缺少必填环境变量：${key}`);
  }
}

const appId = process.env.FEISHU_APP_ID as string;
const appSecret = process.env.FEISHU_APP_SECRET as string;
const groupChatMode = process.env.FEISHU_GROUP_CHAT_MODE || "mention";
const botOpenId = process.env.FEISHU_BOT_OPEN_ID;
const ackReaction = process.env.FEISHU_ACK_REACTION || "OK";
const codexBin = process.env.CODEX_BIN || "codex";
const codexSandboxRaw = process.env.CODEX_SANDBOX || "read-only";
const codexModel = process.env.CODEX_MODEL;
const codexWorkdir = process.env.CODEX_WORKDIR || process.cwd();
const codexPromptTemplateDir = process.env.CODEX_PROMPT_DIR;
const extraSystemPrompt = process.env.CODEX_SYSTEM_PROMPT;

if (!sandboxModes.includes(codexSandboxRaw as SandboxMode)) {
  throw new Error(
    `CODEX_SANDBOX 配置无效：${codexSandboxRaw}。可选值只有：${sandboxModes.join("、")}`,
  );
}

const codexSandbox = codexSandboxRaw as SandboxMode;

function getSystemPrompt(): string {
  return buildSystemPrompt({
    workdir: codexWorkdir,
    sandbox: codexSandbox,
    extraPrompt: extraSystemPrompt,
    templateDir: codexPromptTemplateDir,
  });
}

const larkClient = new Lark.Client({
  appId,
  appSecret,
});

const wsClient = new Lark.WSClient({
  appId,
  appSecret,
  loggerLevel: Lark.LoggerLevel.info,
});

const historyByChat = new Map<string, ChatTurn[]>();
const handledMessageIds = new Set<string>();
const MAX_HISTORY_TURNS = 12;

function parseIncomingText(content: string): string {
  try {
    const parsed = JSON.parse(content) as TextMessageContent;
    return (parsed.text || "").trim();
  } catch {
    return content.trim();
  }
}

function sanitizeUserText(text: string): string {
  return text.replace(/<at[^>]*>.*?<\/at>/g, "").trim();
}

function parseIncomingImageKey(content: string): string | null {
  try {
    const parsed = JSON.parse(content) as ImageMessageContent;
    return parsed.image_key?.trim() || null;
  } catch {
    return null;
  }
}

function getImageExtension(contentType?: string): string {
  switch ((contentType || "").split(";")[0].trim().toLowerCase()) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    case "image/tiff":
      return ".tiff";
    case "image/bmp":
      return ".bmp";
    case "image/x-icon":
    case "image/vnd.microsoft.icon":
      return ".ico";
    default:
      return ".img";
  }
}

function isSupportedImagePath(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return [
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
    ".gif",
    ".tiff",
    ".tif",
    ".bmp",
    ".ico",
  ].includes(ext);
}

function normalizeCandidateImagePath(filePath: string): string | null {
  const normalized = filePath.trim();
  if (!normalized || !isSupportedImagePath(normalized)) {
    return null;
  }

  const resolved = path.isAbsolute(normalized)
    ? normalized
    : path.resolve(codexWorkdir, normalized);

  return existsSync(resolved) ? resolved : null;
}

function parseReplyPayload(reply: string): ReplyPayload {
  const imagePaths = new Set<string>();

  const markdownImagePattern = /!\[[^\]]*]\(([^)\n]+)\)/g;
  for (const match of reply.matchAll(markdownImagePattern)) {
    const imagePath = normalizeCandidateImagePath(match[1] || "");
    if (imagePath) {
      imagePaths.add(imagePath);
    }
  }

  const plainPathPattern =
    /(^|\n)(\.{0,2}\/?[^\s<>"')\]]+\.(?:png|jpe?g|webp|gif|tiff?|bmp|ico))(?=\n|$)/gi;
  for (const match of reply.matchAll(plainPathPattern)) {
    const imagePath = normalizeCandidateImagePath(match[2] || "");
    if (imagePath) {
      imagePaths.add(imagePath);
    }
  }

  const inlineCodePathPattern = /`([^`\n]+\.(?:png|jpe?g|webp|gif|tiff?|bmp|ico))`/gi;
  for (const match of reply.matchAll(inlineCodePathPattern)) {
    const imagePath = normalizeCandidateImagePath(match[1] || "");
    if (imagePath) {
      imagePaths.add(imagePath);
    }
  }

  let text = reply.replace(markdownImagePattern, (fullMatch, imagePath: string) => {
    return normalizeCandidateImagePath(imagePath) ? "" : fullMatch;
  });
  text = text.replace(plainPathPattern, (fullMatch, prefix: string, imagePath: string) => {
    return normalizeCandidateImagePath(imagePath) ? prefix : fullMatch;
  });
  text = text.replace(inlineCodePathPattern, (fullMatch, imagePath: string) => {
    return normalizeCandidateImagePath(imagePath) ? "" : fullMatch;
  });
  text = text.trim();
  text = text.replace(/\n{3,}/g, "\n\n");

  return {
    text,
    imagePaths: [...imagePaths],
  };
}

function trimHistory(turns: ChatTurn[]): ChatTurn[] {
  return turns.slice(-MAX_HISTORY_TURNS);
}

function shouldReplyInGroup(
  mentions: Array<{
    id?: { open_id?: string };
  }> = [],
): boolean {
  if (groupChatMode === "all") {
    return true;
  }

  if (botOpenId) {
    return mentions.some((mention) => mention.id?.open_id === botOpenId);
  }

  return mentions.length > 0;
}

async function generateReply(
  chatId: string,
  userText: string,
  imagePaths: string[] = [],
  historyText = userText,
): Promise<string> {
  const history = historyByChat.get(chatId) || [];
  const systemPrompt = getSystemPrompt();
  const transcript = [...history, { role: "user" as const, content: historyText }]
    .map((turn) => `${turn.role.toUpperCase()}: ${turn.content}`)
    .join("\n\n");
  const prompt = `${systemPrompt}

Conversation so far:
${transcript}

Reply to the latest USER message only.
When you create or reference an image that should be sent back to the user in Feishu, include the image file path in your final reply. Prefer an absolute path or Markdown image syntax like ![label](/absolute/path.png). Relative paths are resolved from the working directory.`;

  const outputText = await runCodex(prompt, imagePaths);
  if (!outputText) {
    throw new Error("Codex 返回了空内容");
  }

  const nextHistory = trimHistory([
    ...history,
    { role: "user", content: historyText },
    { role: "assistant", content: outputText },
  ]);
  historyByChat.set(chatId, nextHistory);

  return outputText;
}

async function runCodex(prompt: string, imagePaths: string[] = []): Promise<string> {
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "-C",
    codexWorkdir,
    "-s",
    codexSandbox,
  ];

  if (codexModel) {
    args.push("-m", codexModel);
  }

  for (const imagePath of imagePaths) {
    args.push("-i", imagePath);
  }

  args.push(prompt);

  return new Promise((resolve, reject) => {
    const child = spawn(codexBin, args, {
      cwd: codexWorkdir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Codex 进程退出，状态码 ${code}：${stderr || stdout}`));
        return;
      }

      const lines = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

      const messages = lines
        .map((line) => {
          try {
            return JSON.parse(line) as CodexJsonEvent;
          } catch {
            return null;
          }
        })
        .filter((event): event is CodexJsonEvent => Boolean(event))
        .filter(
          (event) =>
            event.type === "item.completed" &&
            event.item?.type === "agent_message" &&
            Boolean(event.item.text),
        )
        .map((event) => event.item?.text?.trim() || "")
        .filter(Boolean);

      const lastMessage = messages.at(-1);
      if (!lastMessage) {
        reject(new Error(`无法解析 Codex 输出：${stdout}`));
        return;
      }

      resolve(lastMessage);
    });
  });
}

async function sendText(chatId: string, text: string): Promise<void> {
  await larkClient.im.message.create({
    params: {
      receive_id_type: "chat_id",
    },
    data: {
      receive_id: chatId,
      msg_type: "text",
      content: JSON.stringify({ text }),
    },
  });
}

async function sendImage(chatId: string, imagePath: string): Promise<void> {
  const upload = await larkClient.im.image.create({
    data: {
      image_type: "message",
      image: createReadStream(imagePath),
    },
  });

  const imageKey = upload?.image_key;
  if (!imageKey) {
    throw new Error(`上传图片失败：${imagePath}`);
  }

  await larkClient.im.message.create({
    params: {
      receive_id_type: "chat_id",
    },
    data: {
      receive_id: chatId,
      msg_type: "image",
      content: JSON.stringify({ image_key: imageKey }),
    },
  });
}

async function sendReply(chatId: string, reply: string): Promise<void> {
  const payload = parseReplyPayload(reply);

  if (payload.text) {
    await sendText(chatId, payload.text);
  } else if (payload.imagePaths.length > 0) {
    await sendText(chatId, "图片已发送。");
  }

  for (const imagePath of payload.imagePaths) {
    await sendImage(chatId, imagePath);
  }

  if (!payload.text && payload.imagePaths.length === 0) {
    await sendText(chatId, reply);
  }
}

async function sendAckReaction(messageId: string): Promise<void> {
  if (!ackReaction) {
    return;
  }

  await larkClient.im.messageReaction.create({
    path: {
      message_id: messageId,
    },
    data: {
      reaction_type: {
        emoji_type: ackReaction,
      },
    },
  });
}

async function downloadImageFromMessage(message: IncomingMessage): Promise<string> {
  const imageKey = parseIncomingImageKey(message.content);
  if (!imageKey) {
    throw new Error(`无法解析图片消息内容：${message.content}`);
  }

  const response = await larkClient.im.messageResource.get({
    path: {
      message_id: message.message_id,
      file_key: imageKey,
    },
    params: {
      type: "image",
    },
  });

  const tempDir = await mkdtemp(path.join(tmpdir(), "codex-feishu-image-"));
  const contentType =
    response.headers?.["content-type"] || response.headers?.["Content-Type"];
  const filePath = path.join(
    tempDir,
    `incoming${getImageExtension(Array.isArray(contentType) ? contentType[0] : contentType)}`,
  );

  await response.writeFile(filePath);
  return filePath;
}

async function processTextMessage(message: IncomingMessage): Promise<void> {
  const rawText = parseIncomingText(message.content);
  const userText = sanitizeUserText(rawText);

  if (!userText) {
    await sendText(message.chat_id, "请直接发送文字问题。");
    return;
  }

  try {
    await sendAckReaction(message.message_id);
  } catch (error) {
    console.error("发送已收到 reaction 失败", error);
  }

  try {
    const reply = await generateReply(message.chat_id, userText);
    await sendReply(message.chat_id, reply);
  } catch (error) {
    console.error("处理消息失败", error);
    await sendText(message.chat_id, "处理消息时出错了，请稍后再试。");
  }
}

async function processImageMessage(message: IncomingMessage): Promise<void> {
  try {
    await sendAckReaction(message.message_id);
  } catch (error) {
    console.error("发送已收到 reaction 失败", error);
  }

  let imagePath: string | null = null;

  try {
    imagePath = await downloadImageFromMessage(message);
    const userText =
      "用户发来了一张图片。请先根据图片内容直接回答；如果缺少上下文，就先简要描述图片里有什么，并询问对方希望你进一步做什么。";
    const reply = await generateReply(
      message.chat_id,
      userText,
      [imagePath],
      "[用户发送了一张图片，请结合图片内容回答。]",
    );
    await sendReply(message.chat_id, reply);
  } catch (error) {
    console.error("处理图片消息失败", error);
    await sendText(
      message.chat_id,
      "图片收到了，但处理失败。请确认机器人有读取图片资源的权限后再试。",
    );
  } finally {
    if (imagePath) {
      await rm(path.dirname(imagePath), { recursive: true, force: true }).catch(
        (cleanupError) => {
          console.error("清理临时图片失败", cleanupError);
        },
      );
    }
  }
}

async function handleMessage(event: {
  sender: {
    sender_type: string;
  };
  message: {
    message_id: string;
    chat_id: string;
    chat_type: string;
    message_type: string;
    content: string;
    mentions?: Array<{
      id?: { open_id?: string };
    }>;
  };
}): Promise<void> {
  const { sender, message } = event;

  if (sender.sender_type === "app") {
    return;
  }

  if (handledMessageIds.has(message.message_id)) {
    return;
  }
  handledMessageIds.add(message.message_id);

  if (message.message_type !== "text" && message.message_type !== "image") {
    await sendText(message.chat_id, "目前只支持文本和图片消息。");
    return;
  }

  if (
    message.chat_type === "group" ||
    message.chat_type === "group_chat"
  ) {
    if (!shouldReplyInGroup(message.mentions)) {
      return;
    }
  }

  if (message.message_type === "image") {
    void processImageMessage(message);
    return;
  }

  void processTextMessage(message);
}

const dispatcher = new Lark.EventDispatcher({}).register({
  "im.message.receive_v1": handleMessage,
});

async function main(): Promise<void> {
  console.log("正在启动飞书机器人桥接服务...");
  await wsClient.start({
    eventDispatcher: dispatcher,
  });
  console.log("飞书机器人桥接服务已启动。");
}

main().catch((error) => {
  console.error("启动失败", error);
  process.exit(1);
});
