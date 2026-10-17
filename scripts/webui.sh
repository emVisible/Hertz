#!/bin/bash
# Hertz 一键启动（桌面版）：PostgreSQL 检查 → 迁移 → 后端 :8787 → 前端 :3000 → Electron。
# 逻辑与同目录的 dev.sh 一致；曾是根目录快捷入口，2026-10-17 归位到 scripts/。
exec "$(cd "$(dirname "$0")" && pwd)/dev.sh"
