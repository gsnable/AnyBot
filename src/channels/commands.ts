import type { ChannelCallbacks } from "./types.js";

export interface CommandResult {
  handled: boolean;
  reply?: string;
}

export function handleCommand(
  userText: string,
  chatId: string,
  source: string,
  callbacks: ChannelCallbacks,
): CommandResult {
  const trimmed = userText.trim();

  if (trimmed === "/new" || trimmed === "/reset" || trimmed === "/start") {
    callbacks.resetSession(chatId, source);
    return { handled: true, reply: "新窗口已开启，我们可以继续聊天了" };
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
    "/new — 开启新窗口",
    "/provider — 查看/切换供应商",
    "/model — 查看/切换模型",
    "/help — 显示此帮助",
    "",
    "示例：/provider",
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
