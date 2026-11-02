#!/bin/bash
# 理财产品聚焦 — macOS 启动器（双击运行；关闭本窗口即停止服务）
cd "$(dirname "$0")"
PORT="${1:-8766}"
echo "理财产品聚焦 本地服务 (macOS)"
echo "打开 http://localhost:${PORT}/  （务必 http://，不要 file://）"
echo "关闭本窗口或 Ctrl+C 即停止服务"
exec node serve.mjs "$PORT"
