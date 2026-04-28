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

  // 1. 重置会话
  if (trimmed === "/new" || trimmed === "/reset" || trimmed === "/start") {
    await callbacks.stopSession(chatId);
    callbacks.resetSession(chatId, source);
    return { handled: true, reply: "会话已重置，之前的进程已停止，我们可以开始新对话了。" };
  }

  // 2. 停止任务
  if (trimmed === "/stop" || trimmed === "/kill") {
    await callbacks.stopSession(chatId);
    return { handled: true, reply: "已尝试停止当前正在运行的 AI 任务。" };
  }

  // 3. 重试
  if (trimmed === "/retry") {
    await callbacks.stopSession(chatId);
    const reply = await callbacks.retryReply(chatId, source);
    return { handled: true, reply };
  }

  // 4. 列出历史会话
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

  // 5. 切换历史会话
  if (trimmed.startsWith("/resume")) {
    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) {
      return { handled: true, reply: "请输入要切换的会话编号（例如：/resume 1）。您可以发送 /chats 查看最近的会话列表。" };
    }
    const index = parseInt(parts[1], 10) - 1;
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

  // 6. 帮助
  if (trimmed === "/help") {
    return { handled: true, reply: formatHelp() };
  }

  // 7. 供应商切换
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

  // 8. 模型切换
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

  // 9. 工作目录管理
  if (trimmed === "/cwd") {
    const current = callbacks.getWorkdir(chatId, source);
    return { handled: true, reply: `📍 当前工作目录：\n\`${current}\`` };
  }

  if (trimmed.startsWith("/cwd ")) {
    const newDir = trimmed.slice("/cwd ".length).trim();
    if (!newDir) {
      const current = callbacks.getWorkdir(chatId, source);
      return { handled: true, reply: `📍 当前工作目录：\n\`${current}\`` };
    }
    callbacks.setWorkdir(chatId, source, newDir);
    return { handled: true, reply: `✅ 已切换工作目录至：\n\`${newDir}\`\n\n接下来的对话将在此目录下进行。` };
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
    "/cwd — 查看当前工作目录",
    "/cwd <路径> — 切换工作目录",
    "/stop — 停止正在运行的任务",
    "/retry — 重新执行最后一次提问",
    "/reset — 停止任务并重置记忆",
    "/provider — 查看/切换供应商",
    "/model — 查看/切换模型",
    "/help — 显示此帮助",
    "",
    "示例：/resume 1",
    "示例：/cwd /root/my-project",
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
