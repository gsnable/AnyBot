import { existsSync, statSync } from "node:fs";
import type { ChannelCallbacks } from "./types.js";

export interface CommandResult {
  handled: boolean;
  reply?: string;
  title?: string;
  replaceCurrent?: boolean;
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
    return {
      handled: true,
      title: "💬 会话重置",
      reply: [
        "✅ 会话已重置，之前的进程已停止，我们可以开始新对话了。",
        "",
        "[BUTTON: /settings | ⚙️ 控制中心 | default]",
        "[BUTTON: /chats | 📂 恢复历史会话 | default]",
      ].join("\n"),
    };
  }

  // 2. 停止任务
  if (trimmed === "/stop" || trimmed === "/kill") {
    await callbacks.stopSession(chatId);
    return {
      handled: true,
      title: "⏹️ 任务停止",
      reply: [
        "已尝试停止当前正在运行的 AI 任务。",
        "",
        "[BUTTON: /retry | 🔄 重新生成上一条 | primary]",
        "[BUTTON: /settings | ⚙️ 控制中心 | default]",
      ].join("\n"),
    };
  }

  // 3. 重试
  if (trimmed === "/retry") {
    await callbacks.stopSession(chatId);
    const reply = await callbacks.retryReply(chatId, source);
    return { handled: true, reply };
  }

  // 4. 列出历史会话（带一键切换按钮）
  if (trimmed === "/chats") {
    const sessions = await callbacks.listUserSessions(chatId, source);
    if (sessions.length === 0) {
      return {
        handled: true,
        title: "📂 历史会话",
        reply: "您目前还没有任何历史会话记录。\n\n[BUTTON: /settings | ⚙️ 控制中心 | default]",
      };
    }
    const lines = ["📂 **最近历史会话**（点击下方按钮直接切换）：", ""];
    const buttons: string[] = [];
    sessions.slice(0, 10).forEach((s, i) => {
      const timeStr = new Date(s.updatedAt).toLocaleString("zh-CN", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
      const shortTitle = s.title.length > 16 ? s.title.slice(0, 16) + "..." : s.title;
      lines.push(`${i + 1}. [${timeStr}] ${s.title}`);
      buttons.push(`[BUTTON: /resume ${i + 1} | 🎬 ${i + 1}. ${shortTitle} | default]`);
    });
    lines.push("", buttons.join(" "));
    lines.push("", "[BUTTON: /menu_session | 🔙 返回会话管理 | default]");
    return {
      handled: true,
      title: "📂 历史会话",
      replaceCurrent: true,
      reply: lines.join("\n"),
    };
  }

  // 5. 切换历史会话
  if (trimmed.startsWith("/resume")) {
    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) {
      return {
        handled: true,
        reply:
          "请输入要切换的会话编号（例如：/resume 1）。您可以点击下方按钮直接查看列表：\n\n[BUTTON: /chats | 📂 查看历史会话 | default]",
      };
    }
    const index = parseInt(parts[1], 10) - 1;
    const sessions = await callbacks.listUserSessions(chatId, source);
    if (isNaN(index) || index < 0 || index >= sessions.length) {
      return {
        handled: true,
        reply:
          "编号无效，请从历史会话列表中选择。\n\n[BUTTON: /chats | 📂 重新选择会话 | default]",
      };
    }
    const targetSession = sessions[index];
    await callbacks.stopSession(chatId);
    await callbacks.resumeSession(chatId, source, targetSession.id);

    // 获取该会话的历史消息进行回放
    const history = (callbacks as any).getSessionMessages
      ? await (callbacks as any).getSessionMessages(targetSession.id)
      : [];
    const recentMessages = history.slice(-3);
    let historyText = "";
    if (recentMessages.length > 0) {
      historyText =
        "\n\n🎬 【前情提要】：\n" +
        recentMessages
          .map(
            (m: any) =>
              `${m.role === "user" ? "👤 您" : "🤖 富贵"}: ${m.content.slice(0, 50)}${m.content.length > 50 ? "..." : ""}`,
          )
          .join("\n");
    }

    return {
      handled: true,
      title: "🎬 会话切换成功",
      reply: [
        `已成功切回到会话：【${targetSession.title}】。${historyText}`,
        "",
        "您可以继续聊了，或随时使用下方快捷键：",
        "",
        "[BUTTON: /chats | 📂 换其他会话 | default]",
        "[BUTTON: /settings | ⚙️ 控制中心 | default]",
      ].join("\n"),
    };
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
    const providers = callbacks.listProviders();
    const providerButtons = providers
      .map(
        (p) =>
          `[BUTTON: /provider ${p.type} | 🔧 ${p.type} ${p.isCurrent ? "(当前)" : ""} | ${p.isCurrent ? "primary" : "default"}]`,
      )
      .join(" ");

    return {
      handled: true,
      replaceCurrent: true,
      title: "🔧 供应商设置",
      reply: [
        `**${result.message}**`,
        "",
        "请选择要切换的模型服务商：",
        "",
        providerButtons,
        "",
        "[BUTTON: /settings | 🔙 返回上级设置 | danger]",
      ].join("\n"),
    };
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
    const models = callbacks.listModels();
    const modelButtons = models
      .map((m) => {
        const icon = m.id.includes("flash")
          ? "⚡"
          : m.id.includes("pro")
            ? "🚀"
            : "🤖";
        const name = m.id;
        return `[BUTTON: /model ${name} | ${icon} ${name} ${m.isCurrent ? "(当前)" : ""} | ${m.isCurrent ? "primary" : "default"}]`;
      })
      .join(" ");

    return {
      handled: true,
      replaceCurrent: true,
      title: "🧠 模型设置",
      reply: [
        `**${result.message}**`,
        "",
        "请选择要切换的 AI 模型：",
        "",
        modelButtons,
        "",
        "[BUTTON: /settings | 🔙 返回上级设置 | danger]",
      ].join("\n"),
    };
  }

  // 9. 工作目录管理
  if (trimmed === "/cwd") {
    const current = callbacks.getWorkdir(chatId, source);
    return {
      handled: true,
      title: "📍 工作目录",
      reply: [
        `📍 **当前工作目录**：\n\`${current}\``,
        "",
        "快捷切换预设路径：",
        "[BUTTON: /cwd /root/AnyBot-Dev | 📁 AnyBot-Dev | default] [BUTTON: /cwd /root | 📁 /root | default]",
        "",
        "[BUTTON: /menu_sys | 🔙 返回系统环境 | default]",
      ].join("\n"),
    };
  }

  if (trimmed.startsWith("/cwd ")) {
    const newDir = trimmed.slice("/cwd ".length).trim();
    if (!newDir) {
      const current = callbacks.getWorkdir(chatId, source);
      return { handled: true, reply: `📍 当前工作目录：\n\`${current}\`` };
    }

    try {
      if (!existsSync(newDir) || !statSync(newDir).isDirectory()) {
        return {
          handled: true,
          reply: `❌ 切换失败：目录 \`${newDir}\` 不存在或不是一个有效的文件夹。`,
        };
      }
    } catch (e) {
      return {
        handled: true,
        reply: `❌ 切换失败：无法访问路径 \`${newDir}\`。`,
      };
    }

    callbacks.setWorkdir(chatId, source, newDir);
    return {
      handled: true,
      title: "📍 工作目录切换成功",
      reply: [
        `✅ 已成功切换工作目录至：\n\`${newDir}\``,
        "",
        "接下来的对话将在此目录下进行。",
        "",
        "[BUTTON: /menu_sys | 🔙 返回系统环境 | default]",
        "[BUTTON: /settings | ⚙️ 控制中心 | default]",
      ].join("\n"),
    };
  }

  // 10. 统一控制中心 - 一级主菜单
  if (trimmed === "设置" || trimmed === "/settings") {
    const currentDir = callbacks.getWorkdir(chatId, source);
    const models = callbacks.listModels();
    const currentModel = models.find((m) => m.isCurrent)?.name || "默认";
    return {
      handled: true,
      replaceCurrent: true,
      title: "⚙️ 控制中心",
      reply: [
        `📌 **当前系统上下文**：`,
        `• 运行模型：\`${currentModel}\``,
        `• 工作目录：\`${currentDir}\``,
        "",
        "请选择要进入的功能模块：",
        "",
        "[BUTTON: /menu_session | 💬 会话管理 | primary]",
        "[BUTTON: /menu_model | 🧠 引擎与模型 | default]",
        "[BUTTON: /menu_sys | 🖥️ 环境与系统 | default]",
      ].join("\n"),
    };
  }

  // 二级菜单 - 1. 会话管理（集成会话历史切换、任务控制与重置）
  if (trimmed === "/menu_session") {
    const sessions = await callbacks.listUserSessions(chatId, source);
    const lines = [
      "💬 **会话与进程控制**",
      "",
      "👇 **历史会话快速切换**（点击直接切回）：",
    ];
    const sessionButtons: string[] = [];
    if (sessions.length > 0) {
      sessions.slice(0, 6).forEach((s, i) => {
        const shortTitle =
          s.title.length > 12 ? s.title.slice(0, 12) + "..." : s.title;
        sessionButtons.push(
          `[BUTTON: /resume ${i + 1} | 🎬 ${i + 1}. ${shortTitle} | default]`,
        );
      });
      sessionButtons.push(`[BUTTON: /chats | 📂 全部历史 | default]`);
      lines.push(sessionButtons.join(" "));
    } else {
      lines.push("（暂无历史会话记录）");
    }
    lines.push(
      "",
      "⚡ **任务控制**：",
      "[BUTTON: /retry | 🔄 重新生成上一条 | default] [BUTTON: /stop | ⏹️ 紧急停止 | default]",
      "",
      "⚠️ **重置操作**：",
      "[BUTTON: /new | ➕ 开启新窗口 | primary] [BUTTON: /reset | 🧹 清空本轮记忆 | danger]",
      "",
      "[BUTTON: /settings | 🔙 返回控制中心 | default]",
    );
    return {
      handled: true,
      replaceCurrent: true,
      title: "💬 会话管理",
      reply: lines.join("\n"),
    };
  }

  // 二级菜单 - 2. 引擎与模型（展示当前供应商上下文与模型切换）
  if (trimmed === "/menu_model") {
    const providers = callbacks.listProviders();
    const currentProvider =
      providers.find((p) => p.isCurrent)?.type || "默认";
    const models = callbacks.listModels();
    const modelButtons = models
      .map((m) => {
        const icon = m.id.includes("flash")
          ? "⚡"
          : m.id.includes("pro")
            ? "🚀"
            : "🤖";
        const name = m.id;
        return `[BUTTON: /model ${name} | ${icon} ${name} ${m.isCurrent ? "(当前)" : ""} | ${m.isCurrent ? "primary" : "default"}]`;
      })
      .join(" ");

    return {
      handled: true,
      replaceCurrent: true,
      title: "🧠 引擎与模型",
      reply: [
        `当前服务商：\`${currentProvider}\``,
        "",
        "👇 **选择 AI 模型**：",
        modelButtons,
        "",
        "🔄 **服务商调度**：",
        "[BUTTON: /menu_provider | 🔧 切换服务商 (Gemini / Claude) | default]",
        "",
        "[BUTTON: /settings | 🔙 返回控制中心 | danger]",
      ].join("\n"),
    };
  }

  // 三级菜单 - 供应商切换（带联动提示）
  if (trimmed === "/menu_provider") {
    const providers = callbacks.listProviders();
    const currentProvider =
      providers.find((p) => p.isCurrent)?.type || "默认";
    const providerButtons = providers
      .map(
        (p) =>
          `[BUTTON: /provider ${p.type} | 🔧 ${p.type} ${p.isCurrent ? "(当前)" : ""} | ${p.isCurrent ? "primary" : "default"}]`,
      )
      .join(" ");

    return {
      handled: true,
      replaceCurrent: true,
      title: "🔧 服务商切换",
      reply: [
        `当前服务商：\`${currentProvider}\``,
        "⚠️ *注意：切换服务商后，模型列表将自动联动变更。*",
        "",
        "👇 **选择目标服务商**：",
        providerButtons,
        "",
        "[BUTTON: /menu_model | 🔙 返回模型设置 | danger]",
      ].join("\n"),
    };
  }

  // 二级菜单 - 3. 环境与系统
  if (trimmed === "/menu_sys") {
    const currentDir = callbacks.getWorkdir(chatId, source);
    return {
      handled: true,
      replaceCurrent: true,
      title: "🖥️ 环境与系统",
      reply: [
        `📍 **当前工作目录**：\`${currentDir}\``,
        "",
        "请选择系统运维操作：",
        "",
        "[BUTTON: /status | 📊 完整运行指标 | primary]",
        "[BUTTON: /menu_cwd | 📁 切换工作目录 | default]",
        "[BUTTON: /help | 📋 查看完整命令清单 | default]",
        "",
        "[BUTTON: /settings | 🔙 返回控制中心 | danger]",
      ].join("\n"),
    };
  }

  // 三级菜单 - 工作目录切换
  if (trimmed === "/menu_cwd") {
    const currentDir = callbacks.getWorkdir(chatId, source);
    return {
      handled: true,
      replaceCurrent: true,
      title: "📍 工作目录管理",
      reply: [
        `当前路径：\`${currentDir}\``,
        "",
        "👇 **预设工程目录快捷切换**：",
        "[BUTTON: /cwd /root/AnyBot-Dev | 📁 AnyBot-Dev (主工程) | default]",
        "[BUTTON: /cwd /root | 📁 /root (根目录) | default]",
        "",
        "💡 *如需切换至自定义目录，可直接发送：`/cwd <绝对路径>`*",
        "",
        "[BUTTON: /menu_sys | 🔙 返回系统环境 | danger]",
      ].join("\n"),
    };
  }

  return { handled: false };
}

function formatHelp(): string {
  return [
    "📋 **AnyBot 常用指令清单**：",
    "",
    "• `设置` 或 `/settings` — 呼出统一控制中心（三级下钻式动态菜单）",
    "• `/new` — 开启新窗口（解绑当前会话）",
    "• `/chats` — 调取最近历史会话（带一键切换按钮）",
    "• `/resume <编号>` — 切回到指定历史会话",
    "• `/status` — 查看系统与服务器运行状态",
    "• `/cwd` — 查看当前工作目录",
    "• `/cwd <路径>` — 切换工作目录",
    "• `/stop` — 紧急停止正在运行的任务",
    "• `/retry` — 重新执行最后一次提问",
    "• `/reset` — 停止任务并清空当前记忆",
    "• `/provider` — 查看与切换供应商",
    "• `/model` — 查看与切换 AI 模型",
    "• `/help` — 显示此帮助信息",
    "",
    "[BUTTON: /settings | ⚙️ 呼出控制中心 | primary]",
    "[BUTTON: /status | 📊 系统状态 | default]",
    "[BUTTON: /chats | 📂 历史会话 | default]",
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
