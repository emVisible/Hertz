#!/bin/bash
# Hertz 一键启动（桌面版）：PostgreSQL 检查 → 迁移 → 后端 :8787 → 前端 :3000 → Electron。
# 逻辑与 scripts/dev.sh 一致，这里是根目录快捷入口。
exec "$(cd "$(dirname "$0")" && pwd)/scripts/dev.sh"
