# AnyBot 待办任务清单 (TODO)

本项目持久化待办任务清单，由管家王富贵维护。每当系统发现潜在问题、架构缺陷或收到优化建议时，主动登记至本清单，并在飞书交互中向老山爹请示（【同意】、【不同意】、【取消】）。

---

## 待办列表 (Pending Tasks)

### [TODO-003] 修复系统 glibc NSS 共享库缺失及喷嚏网定时任务解析异常
- **任务编号**：`TODO-003`
- **登记时间**：2026-09-17 22:15
- **优先级**：高 (P1)
- **当前状态**：⏳ 等待审批 (WAITING_APPROVAL)
- **问题背景**：
  1. 喷嚏网定时监控脚本（`/root/.gemini/skills/penti-checker/scripts/check_penti.py`）自 2026-09-15 18:20 起在 Crontab 中持续报错：`<urlopen error [Errno 16] Device or resource busy>`，导致昨日与今日未正常定时推送；
  2. 根因在于 09-15 18:17 安装 chromium 依赖中断时，意外导致系统 `/usr/lib/x86_64-linux-gnu/` 下的 `libnss_dns.so.2`、`libnss_files.so.2` 等 4 个 glibc NSS 动态库丢失（`dpkg -V libc6` 证实缺失），致使所有非 proxychains 进程调用 `socket.getaddrinfo()` 均报错；
  3. 脚本缺少超时设置（`timeout`），历史上曾导致 2 个残留卡死的孤儿进程。
- **实施方案**：
  1. **还原 NSS 共享库**：从本地官方 `libc6_2.31-13+deb11u11_amd64.deb` 提取缺失的 `libnss_dns.so.2`、`libnss_files.so.2`、`libnss_compat.so.2`、`libnss_hesiod.so.2` 还原至 `/usr/lib/x86_64-linux-gnu/`，执行 `ldconfig` 并验证 `dpkg -V libc6` 与原生 DNS 解析；
  2. **加固抓取脚本**：为 `check_penti.py` 中 `urllib.request.urlopen` 增加 `timeout=15` 超时防挂死，并通过 `static-validator` 校验；
  3. **清理僵尸进程并补推**：kill 掉历史孤儿进程（PID 968302, 3054576），并立即执行一次推送以补发今日图卦《【喷嚏图卦20260917】你是做不了杀手的》。
- **影响文件**：`/usr/lib/x86_64-linux-gnu/libnss*`、`/root/.gemini/skills/penti-checker/scripts/check_penti.py`

---

## 历史归档 (Completed & Cancelled)

### [TODO-002] 修复交互卡片二级菜单返回失效缺陷与会话历史展示扩容
- **任务编号**：`TODO-002`
- **登记时间**：2026-09-14 15:58
- **完成时间**：2026-09-14 17:05
- **优先级**：高 (P1)
- **最终状态**：✅ 已完成交付 (COMPLETED)
- **审批记录**：老山爹飞书点击【同意】批准执行
- **问题背景**：
  1. 老山爹在飞书端点击“会话管理”进入二级菜单后，点击底部的“🔙 返回控制中心”按钮无反应或提示点击失败；
  2. 会话管理菜单中历史对话硬编码写死仅显示 3 条，展示过少。
- **实施方案**：
  1. **共享卡片规范**：在 `src/lark.ts` 的 `toInteractiveCardObject` 中显式添加 `"update_multi": true`，遵循飞书多次连续交互更新规范；
  2. **回调结构规范化**：在 `src/channels/feishu.ts` 的 `handleCardAction` 中将卡片原地替换回调严格包裹为 `{ card: cardObj, toast: ... }` 标准格式；
  3. **历史会话扩容**：在 `src/channels/commands.ts` 中将 `/menu_session` 的展示上限由 3 扩充至 6，并在末尾增设 `[BUTTON: /chats | 📂 全部历史 | default]` 快捷入口；同时将 `/chats` 展示上限由 5 扩充为 10 条全量输出。
- **影响文件**：`src/lark.ts`、`src/channels/feishu.ts`、`src/channels/commands.ts`

### [TODO-001] 飞书群聊图片摄入与媒体暂存优化
- **任务编号**：`TODO-001`
- **登记时间**：2026-09-13 15:50
- **完成时间**：2026-09-13 16:01
- **优先级**：高 (P1)
- **最终状态**：✅ 已完成交付 (COMPLETED)
- **审批记录**：老山爹飞书点击【同意】批准执行
- **问题背景**：
  在 `src/channels/feishu.ts` 中，群聊门禁检查先于图片分流处理。因为飞书纯图片无法附带 `@` 标记，导致群聊内图片被当场静默丢弃；后续文字提问无法关联图片上下文。
- **实施方案**：
  1. **摄入解耦**：将图片与文件的本地下载落盘前置到群聊门禁判断之前，无论是否 `@` 均静默下载落盘；
  2. **Per-Chat 媒体暂存池**：在 `FeishuChannel` 中维护 `mediaBuffer`（10 分钟 TTL，最多保留 5 个媒体），并在文字消息到达时由 `consumeRecentMedia` 自动注入该暂存路径，彻底消除上下文断裂；
  3. **门禁精准拦截**：仅在决定是否唤醒大模型（LLM）时执行 `@` 校验，未 `@` 时静默暂存并反馈 ACK Reaction。
- **影响文件**：`src/channels/feishu.ts`
