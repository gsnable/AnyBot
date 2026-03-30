import "dotenv/config";
import * as fsPromises from "node:fs/promises";
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
  getSandbox,
} from "./shared.js";

const providerType = process.env.PROVIDER || "codex";

function getProviderConfig(type: string): Record<string, unknown> {
  switch (type) {
    case "codex":
      return { bin: process.env.CODEX_BIN };
    case "gemini-cli":
      return {
        bin: process.env.GEMINI_CLI_BIN,
        approvalMode: process.env.GEMINI_CLI_APPROVAL_MODE || "yolo",
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

const provider = initProvider(providerType, getProviderConfig(providerType));

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

// --- Core logic ---

function getSessionGeneration(chatId: string): number {
  return sessionGenerationByChat.get(chatId) || 0;
}

function resetChatSession(chatId: string, source?: string): void {
  sessionIdByChat.delete(chatId);
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
  
  // 增加对通用错误的详细说明，方便调试
  if (error instanceof Error) {
    return `处理消息时出错了: ${error.message}`;
  }
  
  return "处理消息时出错了，原因未知。";
}

function getOrCreateChannelSession(
  source: string,
  chatId: string,
): db.ChatSession {
  const existing = db.findSessionBySourceChat(source, chatId);
  if (existing) return existing;

  const session: db.ChatSession = {
    id: generateId(),
    title: "新对话",
    sessionId: null,
    source,
    chatId,
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  db.createSession(session);
  return session;
}

async function generateReply(
  chatId: string,
  userText: string,
  imagePaths: string[] = [],
  source: string = "unknown",
): Promise<string> {
  try {
    const dbSession = getOrCreateChannelSession(source, chatId);
    
    // 如果内存中没有 sessionId，但数据库中有，则尝试恢复它（实现重启后的记忆接续）
    if (!sessionIdByChat.has(chatId) && dbSession.sessionId) {
      sessionIdByChat.set(chatId, dbSession.sessionId);
      logger.info("reply.session_recovered", { chatId, sessionId: dbSession.sessionId });
    }

    const sessionId = sessionIdByChat.get(chatId);
    const sessionGeneration = getSessionGeneration(chatId);
    const prompt = sessionId
      ? buildResumePrompt(userText, source)
      : buildFirstTurnPrompt(userText, source);

    db.addMessage(dbSession.id, "user", userText);

    // 统一图片存储逻辑：将所有图片备份到持久化目录
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
        // 备份成功后，删除原始临时文件以节省空间
        if (imgPath.includes("/tmp/")) {
          await fsPromises.unlink(imgPath).catch(() => {});
        }
      } catch (e) {
        logger.warn("image.copy_failed", { imgPath, newPath, error: e });
        persistentImagePaths.push(imgPath);
      }
    }

    if (dbSession.messages.length <= 1) {
      dbSession.title = generateTitle(userText);
    }

    logger.info("reply.generate.start", {
      chatId,
      source,
      provider: getProvider().type,
      mode: sessionId ? "resume" : "new",
      sessionId: sessionId || null,
      dbSessionId: dbSession.id,
      userTextChars: userText.length,
      promptChars: prompt.length,
      ...(shouldLogContent ? { userText: rawLogString(userText) } : {}),
      ...(shouldLogPrompt ? { prompt: rawLogString(prompt) } : {}),
    });

    let result = await getProvider().run({
      workdir: getWorkdir(),
      sandbox: getSandbox(),
      model: getCurrentModel(),
      prompt,
      imagePaths: persistentImagePaths,
      sessionId: sessionId || undefined,
    }).catch(async (error) => {
      // 核心重试逻辑：如果 Session 找不到了，尝试通过数据库重构上下文
      if (error instanceof ProviderSessionNotFoundError) {
        logger.warn("reply.session_not_found_retry", { chatId, oldSessionId: sessionId });
        
        // 从数据库获取历史消息（排除最后一条刚存入的用户消息）
        const historyMessages = dbSession.messages.slice(0, -1);
        
        // 如果历史太长（超过 100 轮），这里未来可以扩展自动压缩逻辑
        // 目前先取全量或最近的大量记录
        const historyText = historyMessages.map(m => 
          `${m.role === "user" ? "用户" : "Gemini"}: ${m.content}`
        ).join("\n");

        const reconstructedPrompt = `SYSTEM: 你是一个具备持久记忆的助手。以下是由于系统重启而恢复的历史对话记录，请基于此背景继续回答用户的新问题。

HISTORY:
${historyText}

CURRENT_QUESTION:
${userText}`;

        // 发起第二次尝试，这次不带 sessionId
        return await getProvider().run({
          workdir: getWorkdir(),
          sandbox: getSandbox(),
          model: getCurrentModel(),
          prompt: reconstructedPrompt,
          imagePaths: persistentImagePaths,
          sessionId: undefined,
        });
      }
      throw error; // 其他错误照常抛出
    });

    if (result.sessionId && sessionGeneration === getSessionGeneration(chatId)) {
      sessionIdByChat.set(chatId, result.sessionId);
    }

    db.addMessage(dbSession.id, "assistant", result.text);
    db.updateSession({
      id: dbSession.id,
      title: dbSession.title,
      sessionId: result.sessionId || dbSession.sessionId,
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
  generateReply: (chatId, userText, imagePaths, source) =>
    generateReply(chatId, userText, imagePaths, source),
  resetSession: resetChatSession,
  listProviders,
  switchProvider: handleSwitchProvider,
  listModels,
  switchModel: handleSwitchModel,
};

// --- Startup ---

const WEB_PORT = parseInt(process.env.WEB_PORT || "19981", 10);

async function main(): Promise<void> {
  try {
    applyProxy();
  } catch (error) {
    logger.warn("proxy.init_failed", { error });
  }

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

  // db.detachAllChannelSessions();
  // logger.info("service.channel_sessions_detached");

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
