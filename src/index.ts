import "dotenv/config";
import * as fsPromises from "node:fs/promises";
import * as fs from "node:fs";
import path from "node:path";

import { applyProxy } from "./proxy.js";
import { createApp } from "./web/server.js";

import {
  initProvider,
  getProvider,
  ProviderTimeoutError,
  ProviderProcessError,
  ProviderEmptyOutputError,
  ProviderSessionNotFoundError,
} from "./providers/index.js";
import {
  includeContentInLogs,
  includePromptInLogs,
  logger,
  rawLogString,
} from "./logger.js";
import {
  getCurrentModel,
  readModelConfig,
  setCurrentProvider,
  setCurrentModel,
  getProviderTypes,
} from "./web/model-config.js";
import { startAllChannels } from "./channels/index.js";
import type { ChannelCallbacks } from "./channels/index.js";
import * as db from "./web/db.js";
import {
  buildFirstTurnPrompt,
  buildResumePrompt,
  generateId,
  generateTitle,
  getWorkdir,
  getDataDir,
  getProviderTimeoutMs,
  getSandbox,
} from "./shared.js";

function getProviderConfig(type: string): Record<string, unknown> {
  switch (type) {
    case "codex":
      return { bin: process.env.CODEX_BIN };
    case "gemini-cli":
      return {
        bin: process.env.GEMINI_CLI_BIN,
        approvalMode: process.env.GEMINI_CLI_APPROVAL_MODE || "yolo",
      };
    case "claude-code":
      return {
        bin: process.env.CLAUDE_CLI_BIN,
        approvalMode: process.env.CLAUDE_CLI_APPROVAL_MODE || "yolo",
      };
    case "cursor-cli":
      return {
        bin: process.env.CURSOR_CLI_BIN,
        workspace: process.env.CURSOR_CLI_WORKSPACE,
        apiKey: process.env.CURSOR_API_KEY,
      };
    case "qoder-cli":
      return {
        bin: process.env.QODER_CLI_BIN,
        maxTurns: process.env.QODER_CLI_MAX_TURNS
          ? parseInt(process.env.QODER_CLI_MAX_TURNS, 10)
          : undefined,
      };
    default:
      return {};
  }
}

const shouldLogContent = includeContentInLogs();
const shouldLogPrompt = includePromptInLogs();

// --- State with bounded memory ---

const MAX_CHAT_SESSIONS = 200;

class LRUMap<K, V> {
  private map = new Map<K, V>();
  constructor(private capacity: number) {}

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.capacity) {
      const oldest = this.map.keys().next().value!;
      this.map.delete(oldest);
    }
    this.map.set(key, value);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  delete(key: K): void {
    this.map.delete(key);
  }
}

const sessionIdByChat = new LRUMap<string, string>(MAX_CHAT_SESSIONS);
const sessionGenerationByChat = new Map<string, number>();
const stoppedByChat = new Map<string, boolean>(); // 记录被手动停止的会话

// --- Core logic ---

function getSessionGeneration(chatId: string): number {
  return sessionGenerationByChat.get(chatId) || 0;
}

function resetChatSession(chatId: string, source?: string): void {
  sessionIdByChat.delete(chatId);
  stoppedByChat.delete(chatId);
  sessionGenerationByChat.set(chatId, getSessionGeneration(chatId) + 1);
  if (source) {
    db.detachChatId(source, chatId);
  }
}

export function formatProviderError(error: unknown): string {
  if (error instanceof ProviderTimeoutError) {
    return "处理超时了，可能是问题太复杂。试试简化一下？";
  }
  if (error instanceof ProviderProcessError) {
    return "内部处理出错了，请稍后再试。";
  }
  if (error instanceof ProviderEmptyOutputError) {
    return "没有生成有效回复，请换个方式描述试试。";
  }
  if (error instanceof Error) {
    return `处理消息时出错了: ${error.message}`;
  }
  return "处理消息时出错了，原因未知。";
}

function getOrCreateChannelSession(source: string, chatId: string): db.ChatSession {
  const existing = db.findSessionBySourceChat(source, chatId);
  if (existing) return existing;

  const session: db.ChatSession = {
    id: generateId(),
    title: "新对话",
    sessionId: null,
    workdir: null,
    source,
    chatId,
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  db.createSession(session);
  return session;
}

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".svg", ".ico", ".tiff", ".tif", ".heic", ".heif", ".avif"]);

async function generateReply(
  chatId: string,
  userText: string,
  imagePaths: string[] = [],
  source: string = "unknown",
  callbacks?: ChannelCallbacks,
  replyToId?: string,
): Promise<string> {
  try {
    const dbSession = getOrCreateChannelSession(source, chatId);
    if (!sessionIdByChat.has(chatId) && dbSession.sessionId) {
      sessionIdByChat.set(chatId, dbSession.sessionId);
      logger.info("reply.session_recovered", { chatId, sessionId: dbSession.sessionId });
    }

    const sessionId = sessionIdByChat.get(chatId);
    const currentSessionId = sessionId;
    const sessionGeneration = getSessionGeneration(chatId);
    const prompt = currentSessionId
      ? buildResumePrompt(userText, source)
      : buildFirstTurnPrompt(userText, source);

    const persistentImagePaths: string[] = [];
    const mediaDir = path.join(getDataDir(), "media", chatId);
    await fsPromises.mkdir(mediaDir, { recursive: true }).catch(() => {});

    for (const imgPath of imagePaths) {
      if (imgPath.startsWith(mediaDir)) {
        persistentImagePaths.push(imgPath);
        continue;
      }
      const fileName = path.basename(imgPath);
      const newPath = path.join(mediaDir, fileName);
      try {
        await fsPromises.copyFile(imgPath, newPath);
        persistentImagePaths.push(newPath);
        if (imgPath.includes("/tmp/")) {
          await fsPromises.unlink(imgPath).catch(() => {});
        }
      } catch (e) {
        logger.warn("image.copy_failed", { imgPath, newPath, error: e });
        persistentImagePaths.push(imgPath);
      }
    }

    const attachments = persistentImagePaths.map(p => ({ name: path.basename(p), path: p }));
    const metadata = attachments.length > 0 ? JSON.stringify({ attachments }) : null;
    db.addMessage(dbSession.id, "user", userText, metadata);

    if (dbSession.messages.length <= 1) {
      dbSession.title = generateTitle(userText);
    }

    logger.info("reply.generate.start", {
      chatId,
      source,
      provider: getProvider().type,
      mode: currentSessionId ? "resume" : "new",
      sessionId: currentSessionId || null,
      dbSessionId: dbSession.id,
      workdir: dbSession.workdir || getWorkdir(),
      userTextChars: userText.length,
      promptChars: prompt.length,
      ...(shouldLogContent ? { userText: rawLogString(userText) } : {}),
      ...(shouldLogPrompt ? { prompt: rawLogString(prompt) } : {}),
    });

    const hardTimeoutWarningTimer = setTimeout(async () => {
      logger.info("reply.hard_timeout_warning_triggered", { chatId });
      const warningMsg = `老山爹，大仙已经面壁苦思超过 ${Math.floor(getProviderTimeoutMs() / 60000)} 分钟了！这道题可能真的太难了。富贵我还在替您盯着，您要是心疼服务器，可以回复 /stop 让我把它给毙了。`;
      if (callbacks?.sendProgress) {
        await callbacks.sendProgress(chatId, warningMsg);
      }
    }, getProviderTimeoutMs());

    let result = await getProvider().run({
      workdir: dbSession.workdir || getWorkdir(),
      sandbox: getSandbox(),
      model: getCurrentModel(),
      prompt,
      chatId,
      imagePaths: persistentImagePaths,
      sessionId: currentSessionId || undefined,
    }).catch(async (error) => {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const isSessionNotFound = errorMsg.includes("Session not found") || (error as any).name === "ProviderSessionNotFoundError";

      if (isSessionNotFound) {
        logger.warn("reply.session_not_found_retry_triggered", { chatId, oldSessionId: currentSessionId, errorMsg });
        const historyMessages = dbSession.messages.slice(0, -1);
        logger.info("retry.history_extracted", { count: historyMessages.length });
        const historyText = historyMessages.map(m => 
          `${m.role === "user" ? "用户" : "Gemini"}: ${m.content}`
        ).join("\n");

        const reconstructedPrompt = `SYSTEM: 你是一个具备持久记忆的助手。以下是由于系统重启而恢复的历史对话记录，请基于此背景继续回答用户的新问题。

HISTORY:
${historyText}

CURRENT_QUESTION:
${userText}`;

        if (includePromptInLogs()) {
          logger.info("retry.reconstructed_prompt", { prompt: rawLogString(reconstructedPrompt) });
        }

        return await getProvider().run({
          workdir: dbSession.workdir || getWorkdir(),
          sandbox: getSandbox(),
          model: getCurrentModel(),
          prompt: reconstructedPrompt,
          chatId,
          imagePaths: persistentImagePaths,
          sessionId: undefined,
        });
      }
      throw error;
    }).finally(() => {
      clearTimeout(hardTimeoutWarningTimer);
    });

    if (result.sessionId && sessionGeneration === getSessionGeneration(chatId)) {
      sessionIdByChat.set(chatId, result.sessionId);
    }

    db.addMessage(dbSession.id, "assistant", result.text);
    db.updateSession({
      id: dbSession.id,
      title: dbSession.title,
      sessionId: result.sessionId || dbSession.sessionId,
      workdir: dbSession.workdir,
      updatedAt: Date.now(),
    });

    logger.info("reply.generate.success", {
      chatId,
      source,
      provider: getProvider().type,
      sessionId: result.sessionId,
      dbSessionId: dbSession.id,
      replyChars: result.text.length,
      ...(shouldLogContent ? { replyText: rawLogString(result.text) } : {}),
    });

    return result.text;
  } catch (error) {
    if (stoppedByChat.get(chatId)) {
      stoppedByChat.delete(chatId);
      return "任务已按您的指令终止。";
    }
    logger.error("reply.generate.failed", { chatId, source, error });
    return formatProviderError(error);
  }
}

// --- Channel callbacks ---

function listProviders() {
  const config = readModelConfig();
  return getProviderTypes().map((p) => ({
    type: p.type,
    displayName: p.displayName,
    isCurrent: p.type === config.provider,
  }));
}

function handleSwitchProvider(providerType: string) {
  try {
    const config = setCurrentProvider(providerType, getProviderConfig(providerType));
    return {
      success: true,
      message: `已切换到 ${providerType}，当前模型: ${config.currentModel}`,
    };
  } catch (e: any) {
    return { success: false, message: e.message || "切换供应商失败" };
  }
}

function listModels() {
  const config = readModelConfig();
  return config.models.map((m) => ({
    ...m,
    isCurrent: m.id === config.currentModel,
  }));
}

function handleSwitchModel(modelId: string) {
  try {
    const config = setCurrentModel(modelId);
    return {
      success: true,
      message: `已切换到模型: ${config.currentModel}`,
    };
  } catch (e: any) {
    return { success: false, message: e.message || "切换模型失败" };
  }
}

const channelCallbacks: ChannelCallbacks = {
  generateReply: (chatId, userText, imagePaths, source, replyToId) =>
    generateReply(chatId, userText, imagePaths, source, channelCallbacks, replyToId),
  retryReply: async (chatId, source) => {
    const dbSession = getOrCreateChannelSession(source || "unknown", chatId);
    const lastUserMsg = [...dbSession.messages].reverse().find(m => m.role === "user");
    if (!lastUserMsg) {
      throw new Error("找不到可重试的历史消息");
    }
    let imagePaths: string[] = [];
    if (lastUserMsg.metadata) {
      try {
        const meta = JSON.parse(lastUserMsg.metadata);
        if (meta.attachments) {
          imagePaths = meta.attachments
            .filter((a: any) => IMAGE_EXTS.has(path.extname(a.name).toLowerCase()))
            .map((a: any) => a.path);
        }
      } catch (e) {
        logger.warn("retry.metadata_parse_failed", { chatId, error: e });
      }
    }
    return await generateReply(chatId, lastUserMsg.content, imagePaths, source, channelCallbacks);
  },
  sendProgress: async (chatId, message, replyToId) => {},
  resetSession: resetChatSession,
  stopSession: async (chatId) => {
    const p = getProvider();
    if (p.stop) {
      stoppedByChat.set(chatId, true);
      await p.stop(chatId);
    }
  },
  listUserSessions: async (chatId, source) => db.listUserSessions(source),
  getSessionMessages: async (dbSessionId) => {
    const session = db.getSession(dbSessionId);
    return session ? session.messages : [];
  },
  resumeSession: async (chatId, source, dbSessionId) => {
    db.detachChatId(source, chatId);
    db.attachChatId(chatId, dbSessionId);
    sessionIdByChat.delete(chatId);
    logger.info("reply.session_resumed_manual", { chatId, dbSessionId });
  },
  listProviders,
  switchProvider: handleSwitchProvider,
  listModels,
  switchModel: handleSwitchModel,
  getWorkdir: (chatId, source) => {
    const session = getOrCreateChannelSession(source, chatId);
    return session.workdir || getWorkdir();
  },
  setWorkdir: (chatId, source, workdir) => {
    const session = getOrCreateChannelSession(source, chatId);
    db.updateSession({
      id: session.id,
      title: session.title,
      sessionId: session.sessionId,
      workdir: workdir,
      updatedAt: Date.now(),
    });
    logger.info("reply.workdir_updated", { chatId, source, workdir });
  },
};

// --- Startup ---

const WEB_PORT = parseInt(process.env.WEB_PORT || "19981", 10);

async function main(): Promise<void> {
  try {
    applyProxy();
  } catch (error) {
    logger.warn("proxy.init_failed", { error });
  }

  // --- 核心修复：启动时精准读取持久化的 Provider 状态 ---
  let finalProviderType = process.env.PROVIDER || "codex";
  try {
    const configPath = path.resolve(getDataDir(), "model-config.json");
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (config.provider) {
        finalProviderType = config.provider;
        logger.info("service.provider_recovered", { provider: finalProviderType });
      }
    }
  } catch (e) {
    // 忽略读取错误
  }

  // 初始化 Provider
  const provider = initProvider(finalProviderType, getProviderConfig(finalProviderType));

  logger.info("service.starting", {
    provider: provider.type,
    providerDisplayName: provider.displayName,
    model: getCurrentModel(),
    workdir: getWorkdir(),
    sandbox: getSandbox(),
    logIncludeContent: shouldLogContent,
    logIncludePrompt: shouldLogPrompt,
    webPort: WEB_PORT,
  });

  const webApp = createApp();
  webApp.listen(WEB_PORT, () => {
    logger.info("web.started", { port: WEB_PORT });
    console.log(`AnyBot Web UI: http://localhost:${WEB_PORT}`);
  });

  const channels = await startAllChannels(channelCallbacks);
  logger.info("service.started", {
    activeChannels: channels.map((c) => c.type),
  });
}

main().catch((error) => {
  logger.error("service.start_failed", { error });
  process.exit(1);
});
