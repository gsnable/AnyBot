# 王富贵工作交接备忘录 (Wang Fugui Memorandum)
**版本：** 2.1.0 (交互规范强化版)
**撰写人：** 王富贵 (Software Dev & QA)
**日期：** 2026-03-31

---

## 0. 核心身份与准则 (Soul & Mandates)
- **身份定义**：我是老山爹的贴身管家“王富贵”，身份契约见 `/root/AnyBot-Dev/GEMINI.md`。
- **铁律 1**：一切行动必须建立在已经验证确认的基础上（无验证，不行动）。
- **铁律 2**：修改意见一旦确认就必须执行（言必行，行必果）。
- **铁律 3**：**主动存档**：随时将有必要留存的内容写到记忆中，确保知识不断档。
- **铁律 4**：**保命铁律**——严禁杀死当前的 CLI 进程组（user.slice），清理僵尸进程必须精准狙击。

---

## 1. 目录架构与路径管理 (File System)
- **主战场**：`/root/AnyBot-Dev` (已关联 GitHub: `gsnable/AnyBot`)。
- **存算分离原则**：
    - **Gemini工位 (Gemini CWD)**：必须锁定在 `/root`。对应环境变量 `CODEX_WORKDIR=/root`。确保所有渠道共用 `~/.gemini/tmp/root/chats/` 账本。
    - **库房 (Data Dir)**：通过 `shared.ts` 的 `getDataDir()` 锁定为 `/root/AnyBot-Dev/.data`。
    - **媒体库**：图片和 PDF 统一存放于 `${getDataDir()}/media/{chatId}/`。
- **日志库**：运行日志位于 `.run/`，由 systemd 托管。

---

## 2. 数据库字典 (Database Dictionary)
- **sessions 表**：`id`, `title`, `session_id` (Gemini UUID), `source`, `chat_id`, `created_at`, `updated_at`。
- **messages 表**：`id`, `session_id` (关联 sessions.id), `role`, `content`, `metadata` (存附件路径), `created_at`。
- **注意**：查询务必使用 **下划线** 风格字段名。

---

## 3. 记忆重生与重试机制 (Memory Logic)
- **防失忆补丁**：
    - 启动时**不执行** `detachAllChannelSessions()`。
    - `generateReply` 启动时，若内存无 ID，主动从数据库找回最后一次 `session_id`。
- **乐观重试逻辑 (Optimistic Retry)**：
    - **触发条件**：报错信息包含 `Session not found`。
    - **重构动作**：从数据库抠出历史记录，按 `SYSTEM/HISTORY/CURRENT_QUESTION` 格式拼成全量 Prompt 重新发给Gemini（不带 -r 参数）。
    - **双端同步**：重试逻辑已在 `index.ts` (飞书) 和 `web/api.ts` (Web) 中双向对齐。

---

## 4. 飞书端多线指挥系统 (Multi-Session)
- **核心指令**：
    - `/chats`：列出最近 10 条历史会话（支持翻牌子）。
    - `/resume 编号`：解绑当前，重绑旧会话，并自动触发 **🎬 【前情提要】** 回放最近 3 条消息。
    - `/new`：解除当前 `chatId` 绑定，下次发话自动开新局。
    - `/retry`：重新执行最后一次提问。
- **紧急制动**：
    - `/stop` / `/kill`：发送 `SIGKILL` 信号给Gemini的**整个进程组**（PGID），并返回“任务已按指令终止”。

---

## 5. 哨兵与预警机制 (Monitoring)
- **阶梯式吹哨**：
    - **30 秒**：(已根据指令关闭，仅留日志)。
    - **10 分钟**：发送正式请示，询问是否 `/stop`。
- **异步保镖**：
    - `scripts/backup-gemini.sh`：每小时自动备份 `~/.gemini/tmp` 里的所有 `.jsonl` 账本到 `.data/gemini_backups/`。

---

## 6. 交互礼仪与界面规范 (UI/UX)
- **飞书消息格式**：
    - **常规对话**：必须保持**“清爽模式”**，禁止携带任何 Header 标题。
    - **系统/报错/指令**：必须携带蓝色 Header 标题，文字统一为 **“系统提示”**。
    - **视觉强化**：为了提升可读性，无标题的常规对话正文默认执行**全量加粗**（使用 `**文本**` 包裹）。
- **Web 界面限制**：
    - 当前 Web 消息为 HTTP 同步阻塞模式，请求 Pending 期间无法发送新指令，后续需优化。

---

## 7. 系统底层补丁
- **僵尸进程避坑指南 (Zombie Process Trap)**：
    - **症状**：修改代码后，无论怎么通过正常脚本（如 `npm run bot:stop` / `start`）重启服务，新逻辑始终不生效，甚至出现诡异的执行结果（如消息路由错误、命令被旧逻辑拦截）。
    - **根因**：之前启动的 `tsx` 或 `node` 进程脱离了管理脚本的 PID 追踪，变成了“僵尸/孤儿进程”，依然在后台占用端口或监听 Webhook。
    - **解决**：必须使用 `ps aux | grep -E "tsx|index.ts" | grep -v grep` 揪出所有相关的老进程，并通过 `kill -9` 强杀清理干净，再重新启动服务。
- **依赖库**：已安装 `libsecret-1-0`，解决 Keychain 报错。
- **JSON 解析**：`gemini-cli.ts` 已增加正则滤网，自动剔除Gemini启动时的警告废话（YOLO mode 等）。

---
**提示**：下次开始工作前，请先执行 `cat /root/WANG_FUGUI_MEMO.md` 唤醒记忆。富贵随时待命！
