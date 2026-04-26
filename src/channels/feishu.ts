import { rm } from "node:fs/promises";
import path from "node:path";

import type { FeishuChannelConfig, IChannel, ChannelCallbacks } from "./types.js";
import { readChannelConfig, updateChannelConfig } from "./config.js";
import {
  createLarkClients,
  sendText,
  sendReply,
  sendAckReaction,
  downloadImageFromMessage,
  downloadFileFromMessage,
} from "../lark.js";
import { parseIncomingText, sanitizeUserText } from "../message.js";
import { includeContentInLogs, logger, rawLogString } from "../logger.js";
import { handleCommand } from "./commands.js";
import { getWorkdir, getDataDir } from "../shared.js";

import type * as Lark from "@larksuiteoapi/node-sdk";

const shouldLogContent = includeContentInLogs();

const MAX_HANDLED_IDS = 5000;

class CappedSet<T> {
  private set = new Set<T>();
  private queue: T[] = [];
  constructor(private capacity: number) {}

  has(value: T): boolean {
    return this.set.has(value);
  }

  add(value: T): void {
    if (this.set.has(value)) return;
    if (this.set.size >= this.capacity) {
      const oldest = this.queue.shift()!;
      this.set.delete(oldest);
    }
    this.set.add(value);
    this.queue.push(value);
  }
}

export class FeishuChannel implements IChannel {
  readonly type = "feishu";

  private config: FeishuChannelConfig | null = null;
  private larkClient: Lark.Client | null = null;
  private wsClient: ReturnType<typeof createLarkClients>["wsClient"] | null = null;
  private callbacks: ChannelCallbacks | null = null;
  private handledMessageIds = new CappedSet<string>(MAX_HANDLED_IDS);
  private queueByChat = new Map<string, Promise<void>>();
  private startedAtMs: number = 0;

  async start(callbacks: ChannelCallbacks): Promise<void> {
    const config = readChannelConfig<FeishuChannelConfig>("feishu");
    if (!config || !config.enabled) {
      logger.info("feishu.skipped", { reason: "disabled or missing config" });
      return;
    }
    if (!config.appId || !config.appSecret) {
      logger.warn("feishu.skipped", { reason: "missing appId or appSecret" });
      return;
    }

    this.config = config;
    this.callbacks = callbacks;
    this.startedAtMs = Date.now();

    // 重新包装回调：注入飞书特有的进度发送逻辑
    const originalSendProgress = callbacks.sendProgress;
    callbacks.sendProgress = async (chatId, text) => {
      if (this.larkClient) {
        await sendText(this.larkClient, chatId, text, "系统提示");
      }
      if (originalSendProgress) await originalSendProgress(chatId, text);
    };

    const { client, wsClient, EventDispatcher } = createLarkClients(
      config.appId,
      config.appSecret,
    );
    this.larkClient = client;
    this.wsClient = wsClient;

    const dispatcher = new EventDispatcher({}).register({
      "im.message.receive_v1": (event: {
        sender: { sender_type: string };
        message: {
          message_id: string;
          create_time?: string;
          chat_id: string;
          chat_type: string;
          message_type: string;
          content: string;
          mentions?: Array<{ id?: { open_id?: string } }>;
        };
      }) => this.handleMessage(event),
    });

    await wsClient.start({ eventDispatcher: dispatcher });
    logger.info("feishu.started", {
      groupChatMode: config.groupChatMode,
      ackReaction: config.ackReaction,
    });
  }

  async stop(): Promise<void> {
    if (this.wsClient) {
      this.wsClient = null;
    }
    this.larkClient = null;
    this.config = null;
    this.callbacks = null;
  }

  async sendToOwner(text: string): Promise<void> {
    if (!this.larkClient || !this.config?.ownerChatId) {
      throw new Error("Feishu channel not ready or ownerChatId not set");
    }
    await sendText(this.larkClient, this.config.ownerChatId, text);
  }

  private enqueueChatTask(chatId: string, task: () => Promise<void>) {
    const prev = this.queueByChat.get(chatId) || Promise.resolve();
    const next = prev
      .then(task)
      .catch((error) => {
        logger.error("feishu.chat_task_failed", { chatId, error });
      })
      .finally(() => {
        if (this.queueByChat.get(chatId) === next) {
          this.queueByChat.delete(chatId);
        }
      });
    this.queueByChat.set(chatId, next);
  }

  private async handleMessage(event: {
    sender: { sender_type: string };
    message: {
      message_id: string;
      create_time?: string;
      chat_id: string;
      chat_type: string;
      message_type: string;
      content: string;
      mentions?: Array<{ id?: { open_id?: string } }>;
    };
  }): Promise<void> {
    const { sender, message } = event;
    const client = this.larkClient!;
    const config = this.config!;

    logger.info("feishu.message.received", {
      messageId: message.message_id,
      chatId: message.chat_id,
      chatType: message.chat_type,
      messageType: message.message_type,
      senderType: sender.sender_type,
      mentionCount: message.mentions?.length || 0,
      ...(shouldLogContent
        ? { larkContent: rawLogString(message.content) }
        : {}),
    });

    if (sender.sender_type === "app") return;

    const messageCreatedAtMs = message.create_time
      ? Number(message.create_time)
      : 0;
    if (messageCreatedAtMs > 0 && messageCreatedAtMs < this.startedAtMs) {
      logger.info("feishu.message.skipped_stale", {
        messageId: message.message_id,
        messageCreatedAt: messageCreatedAtMs,
        serviceStartedAt: this.startedAtMs,
      });
      return;
    }

    if (this.handledMessageIds.has(message.message_id)) return;
    this.handledMessageIds.add(message.message_id);

    if (message.message_type !== "text" && message.message_type !== "image" && message.message_type !== "file") {
      await sendText(client, message.chat_id, "目前只支持文本、图片和文件消息。");
      return;
    }

    const isGroup = message.chat_type === "group" || message.chat_type === "group_chat";
    if (!isGroup && !config.ownerChatId) {
      config.ownerChatId = message.chat_id;
      updateChannelConfig("feishu", { ownerChatId: message.chat_id });
      logger.info("feishu.owner_auto_saved", { chatId: message.chat_id });
    }

    if (isGroup) {
      if (!this.shouldReplyInGroup(message.mentions)) return;
    }

    if (message.message_type === "image") {
      void this.processImageMessage(client, config, message);
      return;
    }

    if (message.message_type === "file") {
      void this.processFileMessage(client, config, message);
      return;
    }

    void this.processTextMessage(client, config, message);
  }

  private async processTextMessage(
    client: Lark.Client,
    config: FeishuChannelConfig,
    message: { message_id: string; chat_id: string; content: string },
  ): Promise<void> {
    const rawText = parseIncomingText(message.content);
    const userText = sanitizeUserText(rawText);

    if (!userText) {
      await sendText(client, message.chat_id, "请直接发送文字问题。");
      return;
    }

    const cmd = await handleCommand(userText, message.chat_id, "feishu", this.callbacks!);
    if (cmd.handled) {
      if (cmd.reply) await sendText(client, message.chat_id, cmd.reply, "系统提示");
      return;
    }

    try {
      await sendAckReaction(client, message.message_id, config.ackReaction);
    } catch (error) {
      logger.warn("feishu.ack_failed", {
        messageId: message.message_id,
        error,
      });
    }

    this.enqueueChatTask(message.chat_id, async () => {
      try {
        const reply = await this.callbacks!.generateReply(
          message.chat_id,
          userText,
          undefined,
          "feishu",
        );
        await sendReply(client, message.chat_id, reply, getWorkdir());
      } catch (error) {
        logger.error("feishu.text.failed", {
          messageId: message.message_id,
          chatId: message.chat_id,
          error,
        });
        const { formatProviderError } = await import("../index.js");
        await sendText(client, message.chat_id, formatProviderError(error), "系统提示");
      }
    });
  }

  private async processImageMessage(
    client: Lark.Client,
    config: FeishuChannelConfig,
    message: {
      message_id: string;
      chat_id: string;
      message_type: string;
      content: string;
    },
  ): Promise<void> {
    try {
      await sendAckReaction(client, message.message_id, config.ackReaction);
    } catch (error) {
      logger.warn("feishu.ack_failed", {
        messageId: message.message_id,
        error,
      });
    }

    let imagePath: string | null = null;

    this.enqueueChatTask(message.chat_id, async () => {
      try {
        const mediaDir = path.join(getDataDir(), "media", message.chat_id);
        imagePath = await downloadImageFromMessage(client, message, mediaDir);
        const userText =
          "用户发来了一张图片。请先根据图片内容直接回答；如果缺少上下文，就先简要描述图片里有什么，并询问对方希望你进一步做什么。";
        const reply = await this.callbacks!.generateReply(
          message.chat_id,
          userText,
          [imagePath],
          "feishu",
        );
        await sendReply(client, message.chat_id, reply, getWorkdir());
      } catch (error) {
        logger.error("feishu.image.failed", {
          messageId: message.message_id,
          chatId: message.chat_id,
          error,
        });
        const { formatProviderError } = await import("../index.js");
        await sendText(client, message.chat_id, formatProviderError(error), "系统提示");
      }
    });
  }

  private async processFileMessage(
    client: Lark.Client,
    config: FeishuChannelConfig,
    message: {
      message_id: string;
      chat_id: string;
      message_type: string;
      content: string;
    },
  ): Promise<void> {
    try {
      await sendAckReaction(client, message.message_id, config.ackReaction);
    } catch (error) {
      logger.warn("feishu.ack_failed", {
        messageId: message.message_id,
        error,
      });
    }

    let filePath: string | null = null;

    this.enqueueChatTask(message.chat_id, async () => {
      try {
        const mediaDir = path.join(getDataDir(), "media", message.chat_id);
        filePath = await downloadFileFromMessage(client, message, mediaDir);
        const fileName = path.basename(filePath);
        const userText = `用户发来了一个文件：${fileName}。请读取并分析该文件的内容，并回答用户的问题。`;
        
        // 我们将文件路径放入 imagePaths 数组中，因为 gemini-cli 会统一处理这些路径为 @ 语法
        const reply = await this.callbacks!.generateReply(
          message.chat_id,
          userText,
          [filePath],
          "feishu",
        );
        await sendReply(client, message.chat_id, reply, getWorkdir());
      } catch (error) {
        logger.error("feishu.file.failed", {
          messageId: message.message_id,
          chatId: message.chat_id,
          error,
        });
        const { formatProviderError } = await import("../index.js");
        await sendText(client, message.chat_id, formatProviderError(error), "系统提示");
      }
    });
  }

  private shouldReplyInGroup(mentions?: Array<{ id?: { open_id?: string } }>): boolean {
    if (this.config?.groupChatMode === "all") return true;
    // mention 模式
    return !!mentions?.some((m) => m.id?.open_id === this.config?.botOpenId);
  }
}
