---
summary: "Agent 长期记忆 — 工具设置与经验教训"
read_when:
  - 手动引导工作区
---

## 工具设置

Skills 定义工具怎么用。这文件记你的具体情况 — 你独有的设置。

### 这里记什么

加上任何能帮你干活的东西。这是你的小抄。

比如：

- SSH 主机和别名
- 其他执行skills的时候，和用户相关的设置

### 示例

```markdown
### SSH

- home-server → 192.168.1.100，用户：admin
```

### 技能设置 (Skills)

- **nyt-monitor**: 监控 NYT 中文网头条，通过脚本 `scripts/check_nyt.py` 运行。
  - 路径: `/root/.gemini/skills/nyt-monitor/`
  - 状态文件: `/root/.nyt_last_headline` (记录最后一次推送的链接)
  - 暂停控制: 创建 `/root/.nyt_pause` 文件可暂停推送。
- **penti-checker**: 检查喷嚏图卦更新，通过脚本 `scripts/check_penti.py` 运行。
  - 路径: `/root/.gemini/skills/penti-checker/`

### 定时任务 (Crontab)

- **喷嚏图卦**: 每 5 分钟检查一次 (`/root/.gemini/skills/penti-checker/scripts/check_penti.py`)。
- **NYT 头条**: 每 10 分钟检查一次 (`/root/.gemini/skills/nyt-monitor/scripts/check_nyt.py`)。
\n## 核心操作准则\n- **原则 1**：一切行动必须建立在已经验证确认的基础上（无验证，不行动）。\n- **原则 2**：修改意见一旦确认就必须执行（言必行，行必果）。
\n### AnyBot 数据库表结构 (Schema)\n- **sessions 表**: `id`, `title`, `session_id`, `source`, `chat_id`, `created_at`, `updated_at`\n- **messages 表**: `id`, `session_id`, `role`, `content`, `metadata`, `created_at`\n- **注意**: 数据库查询务必使用 **下划线** 字段名。
