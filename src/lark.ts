import * as Lark from "@larksuiteoapi/node-sdk";
import { createReadStream } from "node:fs";
import { mkdtemp, stat, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { IncomingMessage } from "./types.js";
import { parseIncomingImageKey, parseIncomingFileKey, getImageExtension, parseReplyPayload } from "./message.js";
import { includeContentInLogs, logger, rawLogString } from "./logger.js";

const shouldLogContent = includeContentInLogs();

type LarkCardElement =
  | {
      tag: "markdown";
      content: string;
      text_align?: "left" | "center" | "right";
      text_size?: "normal" | "heading" | "notation";
    }
  | {
      tag: "hr";
    };

function splitMarkdownBlocks(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (!normalized) {
    return [];
  }

  const lines = normalized.split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  let inCodeFence = false;

  const flush = () => {
    if (current.length === 0) return;
    const block = current.join("\n").trim();
    if (block) {
      blocks.push(block);
    }
    current = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      if (!inCodeFence && current.length > 0) {
        flush();
      }
      current.push(line);
      inCodeFence = !inCodeFence;
      if (!inCodeFence) {
        flush();
      }
      continue;
    }

    if (inCodeFence) {
      current.push(line);
      continue;
    }

    if (!trimmed) {
      flush();
      continue;
    }

    const isBullet = /^([-*+]|\d+\.)\s+/.test(trimmed);
    const previousIsBullet =
      current.length > 0 && /^([-*+]|\d+\.)\s+/.test(current[current.length - 1]!.trim());

    if (isBullet && current.length > 0 && !previousIsBullet) {
      flush();
    }

    current.push(line);
  }

  flush();
  return blocks;
}

function buildCardElements(text: string, isLarge?: boolean): LarkCardElement[] {
  const blocks = splitMarkdownBlocks(text);
  if (blocks.length === 0) {
    // 如果包含艾特标签，则不进行全量加粗，防止破坏标签结构
    const shouldBold = isLarge && !text.includes("<at ");
    return [
      {
        tag: "markdown",
        content: shouldBold ? `**${text}**` : text,
      },
    ];
  }

  return blocks.flatMap((block, index) => {
    const shouldBold = isLarge && !block.includes("<at ");
    const elements: LarkCardElement[] = [
      {
        tag: "markdown",
        content: shouldBold ? `**${block}**` : block,
      },
    ];

    if (index < blocks.length - 1) {
      elements.push({ tag: "hr" });
    }

    return elements;
  });
}

function toInteractiveCardContent(text: string, title?: string): string {
  const card: any = {
    config: {
      wide_screen_mode: true,
      enable_forward: true,
    },
    elements: buildCardElements(text, !title), // 没标题时开启放大模式
  };

  if (title) {
    card.header = {
      title: {
        tag: "plain_text",
        content: title,
      },
      template: "blue",
    };
  }

  return JSON.stringify(card);
}

async function sendPlainText(
  client: Lark.Client,
  receiveId: string,
  text: string,
  replyToId?: string,
): Promise<void> {
  const processedText = processMentions(text, "text");

  if (replyToId) {
    const res = await client.im.message.reply({
      path: { message_id: replyToId },
      data: {
        msg_type: "text",
        content: JSON.stringify({ text: processedText }),
      },
    });
    logger.info("lark.api.reply_result", { 
      receiveId, 
      replyToId, 
      code: res.code, 
      msg: res.msg, 
      data: JSON.stringify(res.data) 
    });
  } else {
    await client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: receiveId,
        msg_type: "text",
        content: JSON.stringify({ text: processedText }),
      },
    });
  }
}

const MAX_FILE_SIZE_BYTES = 30 * 1024 * 1024;

type LarkFileType = "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream";

function detectLarkFileType(filePath: string): LarkFileType {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".opus":
      return "opus";
    case ".mp4":
      return "mp4";
    case ".pdf":
      return "pdf";
    case ".doc":
    case ".docx":
      return "doc";
    case ".xls":
    case ".xlsx":
      return "xls";
    case ".ppt":
    case ".pptx":
      return "ppt";
    default:
      return "stream";
  }
}

function processMentions(text: string, mode: "text" | "card"): string {
  return text.replace(/@\{([^|]+)\|([^}]+)\}/g, (_, name, id) => {
    if (id === "all") {
      return mode === "card" ? '<at id="all"></at>' : '<at all="">所有人</at>';
    }
    if (mode === "card") {
      // 交互式卡片中的 markdown 标签使用 id
      return `<at id="${id}"></at>`;
    } else {
      // 标准文本消息使用 user_id，必须包含用户名才能生效
      return `<at user_id="${id}">${name}</at>`;
    }
  });
}

function formatCardFallbackText(text: string): string {
  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}

function isCardContentError(error: unknown): boolean {
  const maybeError = error as {
    code?: number;
    msg?: string;
    message?: string;
    response?: { code?: number; msg?: string };
  };
  const code = maybeError.code ?? maybeError.response?.code;
  const message = maybeError.msg || maybeError.response?.msg || maybeError.message || "";
  return code === 230028 || code === 230099 || /interactive|card|content|invalid user resource/i.test(message);
}

export function createLarkClients(appId: string, appSecret: string) {
  const client = new Lark.Client({ appId, appSecret });
  const wsClient = new Lark.WSClient({
    appId,
    appSecret,
    loggerLevel: Lark.LoggerLevel.info,
  });
  return { client, wsClient, EventDispatcher: Lark.EventDispatcher };
}

export async function sendText(
  client: Lark.Client,
  chatId: string,
  text: string,
  title?: string,
  replyToId?: string,
): Promise<void> {
  logger.debug("lark.send_text", {
    chatId,
    replyToId,
    textChars: text.length,
    ...(shouldLogContent
      ? {
          text: rawLogString(text),
        }
      : {}),
  });

  const processedText = processMentions(text, "card");
  const content = toInteractiveCardContent(processedText, title);

  try {
    if (replyToId) {
      const res = await client.im.message.reply({
        path: { message_id: replyToId },
        data: {
          msg_type: "interactive",
          content,
        },
      });
      logger.info("lark.api.card_reply_result", { 
        chatId, 
        replyToId, 
        code: res.code, 
        msg: res.msg, 
        data: JSON.stringify(res.data) 
      });
    } else {
      const res = await client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          msg_type: "interactive",
          content,
        },
      });
      logger.info("lark.api.card_create_result", { 
        chatId, 
        code: res.code, 
        msg: res.msg, 
        data: JSON.stringify(res.data) 
      });
    }
  } catch (error: unknown) {
    if (!isCardContentError(error)) {
      throw error;
    }
    logger.warn("lark.send_text.card_fallback", {
      chatId,
      error: (error as { message?: string })?.message || String(error),
    });
    await sendPlainText(client, chatId, formatCardFallbackText(text), replyToId);
  }
}

export async function sendImage(
  client: Lark.Client,
  chatId: string,
  imagePath: string,
): Promise<void> {
  logger.info("lark.send_image.start", {
    chatId,
    imagePath,
  });
  const upload = await client.im.image.create({
    data: {
      image_type: "message",
      image: createReadStream(imagePath),
    },
  });

  const imageKey = upload?.image_key;
  if (!imageKey) {
    throw new Error(`上传图片失败：${imagePath}`);
  }

  await client.im.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: chatId,
      msg_type: "image",
      content: JSON.stringify({ image_key: imageKey }),
    },
  });
  logger.info("lark.send_image.success", {
    chatId,
    imagePath,
    imageKey,
  });
}

export async function sendFile(
  client: Lark.Client,
  chatId: string,
  filePath: string,
): Promise<void> {
  logger.info("lark.send_file.start", {
    chatId,
    filePath,
  });

  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) {
    throw new Error(`不是可发送的文件：${filePath}`);
  }
  if (fileStat.size <= 0) {
    throw new Error(`文件为空，无法发送：${filePath}`);
  }
  if (fileStat.size > MAX_FILE_SIZE_BYTES) {
    throw new Error(
      `文件超过 30MB，无法发送：${path.basename(filePath)} (${fileStat.size} bytes)`,
    );
  }

  const upload = await client.im.file.create({
    data: {
      file_type: detectLarkFileType(filePath),
      file_name: path.basename(filePath),
      file: createReadStream(filePath),
    },
  });

  const fileKey = upload?.file_key;
  if (!fileKey) {
    throw new Error(`上传文件失败：${filePath}`);
  }

  const res = await client.im.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: chatId,
      msg_type: "file",
      content: JSON.stringify({ file_key: fileKey }),
    },
  });

  logger.info("lark.send_file.success", {
    chatId,
    filePath,
    fileKey,
    fileSize: fileStat.size,
    code: res.code,
    msg: res.msg
  });
}

export async function sendReply(
  client: Lark.Client,
  chatId: string,
  reply: string,
  workdir: string,
  replyToId?: string,
): Promise<void> {
  const payload = parseReplyPayload(reply, workdir);
  logger.info("lark.send_reply", {
    chatId,
    replyToId,
    textChars: payload.text.length,
    imageCount: payload.imagePaths.length,
    fileCount: payload.filePaths.length,
    ...(shouldLogContent
      ? {
          reply: rawLogString(reply),
          text: rawLogString(payload.text),
        }
      : {}),
  });

  if (payload.text) {
    await sendText(client, chatId, payload.text, undefined, replyToId);
  } else if (payload.imagePaths.length > 0 || payload.filePaths.length > 0) {
    await sendText(client, chatId, "请查收~", undefined, replyToId);
  }

  for (const imagePath of payload.imagePaths) {
    await sendImage(client, chatId, imagePath);
  }

  for (const filePath of payload.filePaths) {
    await sendFile(client, chatId, filePath);
  }

  if (!payload.text && payload.imagePaths.length === 0 && payload.filePaths.length === 0) {
    await sendText(client, chatId, reply, undefined, replyToId);
  }
}

export async function sendAckReaction(
  client: Lark.Client,
  messageId: string,
  emojiType: string,
): Promise<void> {
  if (!emojiType) return;

  logger.debug("lark.send_ack_reaction", {
    messageId,
    emojiType,
  });
  await client.im.messageReaction.create({
    path: { message_id: messageId },
    data: { reaction_type: { emoji_type: emojiType } },
  });
}

export async function downloadImageFromMessage(
  client: Lark.Client,
  message: IncomingMessage,
  storageDir?: string,
): Promise<string> {
  const imageKey = parseIncomingImageKey(message.content);
  if (!imageKey) {
    throw new Error(`无法解析图片消息内容：${message.content}`);
  }

  logger.info("lark.download_image.start", {
    messageId: message.message_id,
    chatId: message.chat_id,
    imageKey,
  });

  const response = await client.im.messageResource.get({
    path: {
      message_id: message.message_id,
      file_key: imageKey,
    },
    params: { type: "image" },
  });

  // 确定存储目录，如果没有传入则使用临时目录
  const finalDir = storageDir || await mkdtemp(path.join(tmpdir(), "codex-feishu-image-"));
  await mkdir(finalDir, { recursive: true }).catch(() => {});

  const contentType =
    response.headers?.["content-type"] || response.headers?.["Content-Type"];
  
  // 使用 message_id 命名，确保同一张图不会重复下载
  const fileName = `${message.message_id}${getImageExtension(Array.isArray(contentType) ? contentType[0] : contentType)}`;
  const filePath = path.join(finalDir, fileName);

  await response.writeFile(filePath);
  logger.info("lark.download_image.success", {
    messageId: message.message_id,
    chatId: message.chat_id,
    imageKey,
    filePath,
  });
  return filePath;
}

export async function downloadFileFromMessage(
  client: Lark.Client,
  message: IncomingMessage,
  storageDir?: string,
): Promise<string> {
  const fileInfo = parseIncomingFileKey(message.content);
  if (!fileInfo) {
    throw new Error(`无法解析文件消息内容：${message.content}`);
  }

  logger.info("lark.download_file.start", {
    messageId: message.message_id,
    chatId: message.chat_id,
    fileKey: fileInfo.key,
    fileName: fileInfo.name,
  });

  const response = await client.im.messageResource.get({
    path: {
      message_id: message.message_id,
      file_key: fileInfo.key,
    },
    params: { type: "file" },
  });

  const finalDir = storageDir || (await mkdtemp(path.join(tmpdir(), "codex-feishu-file-")));
  await mkdir(finalDir, { recursive: true }).catch(() => {});

  const filePath = path.join(finalDir, fileInfo.name);

  await response.writeFile(filePath);
  logger.info("lark.download_file.success", {
    messageId: message.message_id,
    chatId: message.chat_id,
    fileKey: fileInfo.key,
    filePath,
  });
  return filePath;
}
