#!/usr/bin/env bash
# GoldRush 每日分析 — 每天 11:30 由 cron 触发
# 生成 Markdown 报告到 docs/ 目录

set -e

# cron 环境 PATH 有限，补充 opencode CLI 路径
export PATH="/usr/local/bin:/usr/sbin:$PATH"

cd "$(dirname "$0")/.."
PROJECT_DIR="$(pwd)"

# 日志
LOG_DIR="$PROJECT_DIR/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/daily-$(date +%Y-%m-%d).log"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] GoldRush 每日分析开始" >> "$LOG_FILE" 2>&1

# 拉取最新代码（网络失败不阻断）
git pull --rebase >> "$LOG_FILE" 2>&1 || true
# 每次均构建确保 dist/ 与 src/ 一致
echo "[$(date '+%Y-%m-%d %H:%M:%S')] 编译..." >> "$LOG_FILE" 2>&1
npm run build >> "$LOG_FILE" 2>&1

# 运行分析（失败时仍继续告警流程）
set +e
node "$PROJECT_DIR/dist/index.js" analysis --md >> "$LOG_FILE" 2>&1
EXIT_CODE=$?
set -e

# 产出主力监测日报（纯本地计算，秒级）
node "$PROJECT_DIR/dist/index.js" flow --md >> "$LOG_FILE" 2>&1 || true

if [ $EXIT_CODE -eq 0 ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ✅ 分析完成" >> "$LOG_FILE" 2>&1
else
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ❌ 分析失败 (exit code: $EXIT_CODE)" >> "$LOG_FILE" 2>&1
fi

# Webhook 告警（未配置 URL 时静默跳过）
node "$PROJECT_DIR/dist/index.js" notify --daily --exit "$EXIT_CODE" >> "$LOG_FILE" 2>&1 || true

# 周日：周期摘要 + 预测错因反思（驱动下周读报告更准）
if [ "$(date +%u)" -eq 7 ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] 生成周期摘要..." >> "$LOG_FILE" 2>&1
  node "$PROJECT_DIR/dist/index.js" digest --days 7 --md >> "$LOG_FILE" 2>&1 || true
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] 生成预测错因反思..." >> "$LOG_FILE" 2>&1
  node "$PROJECT_DIR/dist/index.js" reflect --days 14 --md --refresh-stats >> "$LOG_FILE" 2>&1 || true
fi

exit $EXIT_CODE
