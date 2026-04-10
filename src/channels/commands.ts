import type { ChannelCallbacks } from "./types.js";

export interface CommandResult {
  handled: boolean;
  reply?: string;
}

export async function handleCommand(
  userText: string,
  chatId: string,
  source: string,
  callbacks: ChannelCallbacks,
): Promise<CommandResult> {
  const trimmed = userText.trim();

  if (trimmed === "/new" || trimmed === "/reset" || trimmed === "/start") {
    await callbacks.stopSession(chatId);
    callbacks.resetSession(chatId, source);
    return { handled: true, reply: "会话已重置，之前的进程已停止，我们可以开始新对话了。" };
  }

  if (trimmed === "/stop" || trimmed === "/kill") {
    await callbacks.stopSession(chatId);
    return { handled: true, reply: "已尝试停止当前正在运行的 AI 任务。" };
  }

  if (trimmed === "/retry") {
    await callbacks.stopSession(chatId);
    const reply = await callbacks.retryReply(chatId, source);
    return { handled: true, reply };
  }

  if (trimmed === "/chats") {
    const sessions = await callbacks.listUserSessions(chatId, source);
    if (sessions.length === 0) {
      return { handled: true, reply: "您目前还没有任何历史会话。" };
    }
    const lines = ["📂 您的最近会话列表："];
    sessions.forEach((s, i) => {
      const timeStr = new Date(s.updatedAt).toLocaleString("zh-CN", { hour12: false });
      lines.push(`${i + 1}. [${timeStr}] ${s.title}`);
    });
    lines.push("", "切换请发送：/resume 编号");
    return { handled: true, reply: lines.join("\n") };
  }

  if (trimmed.startsWith("/resume ")) {
    const index = parseInt(trimmed.slice("/resume ".length).trim(), 10) - 1;
    const sessions = await callbacks.listUserSessions(chatId, source);
    if (isNaN(index) || index < 0 || index >= sessions.length) {
      return { handled: true, reply: "编号无效，请从 /chats 列表中选择。" };
    }
    const targetSession = sessions[index];
    await callbacks.stopSession(chatId);
    await callbacks.resumeSession(chatId, source, targetSession.id);

    // 获取该会话的历史消息进行回放
    const history = (callbacks as any).getSessionMessages ? await (callbacks as any).getSessionMessages(targetSession.id) : [];
    const recentMessages = history.slice(-3); // 只取最后3条
    let historyText = "";
    if (recentMessages.length > 0) {
      historyText = "\n\n🎬 【前情提要】：\n" + recentMessages.map((m: any) => 
        `${m.role === "user" ? "👤 您" : "🤖 富贵"}: ${m.content.slice(0, 50)}${m.content.length > 50 ? "..." : ""}`
      ).join("\n");
    }

    return { handled: true, reply: `已成功切回到会话：【${targetSession.title}】。${historyText}\n\n您可以继续聊了。` };
  }

  if (trimmed === "/help") {
    return { handled: true, reply: formatHelp() };
  }

  if (trimmed === "/provider") {
    return { handled: true, reply: formatProviderList(callbacks) };
  }

  if (trimmed.startsWith("/provider ")) {
    const target = trimmed.slice("/provider ".length).trim();
    if (!target) {
      return { handled: true, reply: formatProviderList(callbacks) };
    }
    const result = callbacks.switchProvider(target);
    return { handled: true, reply: result.message };
  }

  if (trimmed === "/model") {
    return { handled: true, reply: formatModelList(callbacks) };
  }

  if (trimmed.startsWith("/model ")) {
    const target = trimmed.slice("/model ".length).trim();
    if (!target) {
      return { handled: true, reply: formatModelList(callbacks) };
    }
    const result = callbacks.switchModel(target);
    return { handled: true, reply: result.message };
  }

  return { handled: false };
}

function formatHelp(): string {
  return [
    "📋 可用命令：",
    "",
    "/new — 开启新窗口（解绑当前）",
    "/chats — 列出最近的历史会话",
    "/resume 编号 — 切回到指定历史会话",
    "/stop — 停止正在运行的任务",
    "/retry — 重新执行最后一次提问",
    "/reset — 停止任务并重置记忆",
    "/provider — 查看/切换供应商",
    "/model — 查看/切换模型",
    "/help — 显示此帮助",
    "",
    "示例：/resume 1",
    "示例：/model",
  ].join("\n");
}

function formatProviderList(callbacks: ChannelCallbacks): string {
  const providers = callbacks.listProviders();
  const lines = ["🔧 可用供应商："];
  for (const p of providers) {
    const marker = p.isCurrent ? " ✅" : "";
    lines.push(`- ${p.type}${marker}`);
  }
  lines.push("", "切换：/provider 名称");
  return lines.join("\n");
}

function formatModelList(callbacks: ChannelCallbacks): string {
  const models = callbacks.listModels();
  if (models.length === 0) {
    return "当前供应商没有可用模型。";
  }
  const lines = ["🤖 可用模型："];
  for (const m of models) {
    const marker = m.isCurrent ? " ✅" : "";
    lines.push(`- ${m.id}${marker}`);
  }
  lines.push("", "切换：/model 名称");
  return lines.join("\n");
}
