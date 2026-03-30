#!/bin/bash
# Gemini CLI 会话异步备份脚本
# 撰写人：王富贵

SOURCE_DIR="/root/.gemini/tmp"
BACKUP_DIR="/root/AnyBot/.data/gemini_backups"

# 创建备份目录
mkdir -p "$BACKUP_DIR"

# 使用 rsync 进行增量同步，保留所有 jsonl 对话记录
# -a: 归档模式
# -v: 显示详情
# --delete: 源文件删了，备份也跟着删（保持同步）
if command -v rsync >/dev/null 2>&1; then
    rsync -av --include="*/" --include="*.json" --include="*.jsonl" --exclude="*" "$SOURCE_DIR/" "$BACKUP_DIR/"
else
    # 如果没装 rsync，就用普通的 cp
    cp -r "$SOURCE_DIR"/* "$BACKUP_DIR/"
fi

echo "[$(date)] Gemini sessions backed up successfully to $BACKUP_DIR"
