# AnyBot 项目专属规则 (Workspace Rules)

## 1. 目录架构与路径管理 (File System)
- **主工作区**：[/root/AnyBot-Dev](file:///root/AnyBot-Dev)
- **存算分离原则**：
  - **工作目录 (CWD)**：锁定为 `/root`，使用环境变量 `CODEX_WORKDIR=/root`，共享 `~/.gemini/tmp/root/chats/` 账本。
  - **库房 (Data Dir)**：通过 `shared.ts` 的 `getDataDir()` 锁定为 `/root/AnyBot-Dev/.data`。
  - **媒体库**：图片和 PDF 统一存放于 `${getDataDir()}/media/{chatId}/`。
- **日志库**：运行日志位于 `.run/`，由 systemd 托管。

## 2. 数据库字典 (Database Dictionary)
- **sessions 表**：`id`, `title`, `session_id` (Gemini UUID), `source`, `chat_id`, `created_at`, `updated_at`。
- **messages 表**：`id`, `session_id` (关联 sessions.id), `role`, `content`, `metadata` (存附件路径), `created_at`。
- **重要规范**：数据库字段统一使用下划线命名风格，代码中使用驼峰风格。在写 SQL 查询时，**必须使用下划线风格**。

## 3. 记忆重生与重试机制 (Memory Logic)
- **防失忆补丁**：
  - 启动时不执行 `detachAllChannelSessions()`。
  - `generateReply` 启动时，若内存中无 ID，主动从数据库找回最后一次 `session_id`。
- **乐观重试逻辑 (Optimistic Retry)**：
  - **触发条件**：报错信息包含 `Session not found`。
  - **重构动作**：从数据库读取历史记录，按 `SYSTEM/HISTORY/CURRENT_QUESTION` 格式拼成全量 Prompt 重新发给 Gemini（不带 `-r` 参数）。
  - **双端同步**：重试逻辑在 `index.ts` (飞书) 和 `web/api.ts` (Web) 中双向对齐。

## 4. 飞书端控制指令 (Multi-Session Commands)
- `/chats`：列出最近 10 条历史会话。
- `/resume 编号`：解绑当前，重绑旧会话，并自动回放最近 3 条消息。
- `/new`：解除当前 `chatId` 绑定，下次发话自动开新局。
- `/retry`：重新执行最后一次提问。
- `/stop` / `/kill`：发送 `SIGKILL` 信号给 Gemini 的整个进程组（PGID），终止当前任务。

## 5. 哨兵与预警机制 (Monitoring)
- **阶梯式吹哨**：
  - 10 分钟：发送正式请示，询问是否 `/stop`。
- **定时备份**：
  - 脚本 `scripts/backup-gemini.sh`：每小时自动备份 `~/.gemini/tmp` 里的所有 `.jsonl` 账本到 `.data/gemini_backups/`。

## 6. 系统底层补丁与避坑指南 (Troubleshooting)
- **僵尸进程避坑**：
  - **症状**：修改代码重启服务后，新逻辑不生效，甚至出现诡异的路由错误。
  - **根因**：老 `tsx` 或 `node` 进程脱离管理变成僵尸进程，后台霸占端口或 Webhook。
  - **解决**：必须使用 `ps aux | grep -E "tsx|index.ts" | grep -v grep` 揪出所有老进程，并通过 `kill -9` 强杀清理。
- **系统依赖**：必须确保 `libsecret-1-0` 已安装，以解决 Keychain 报错。
