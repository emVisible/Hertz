#!/bin/bash
# Hertz one-command dev launcher: PostgreSQL check → migrations → backend → frontend → Electron
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> [1/5] Checking PostgreSQL..."
if ! pg_isready -q 2>/dev/null; then
  echo "ERROR: PostgreSQL is not running. Start it first (e.g. brew services start postgresql@18)."
  exit 1
fi

echo "==> [2/5] Ensuring database 'hertz' exists..."
if ! psql -d hertz -c "SELECT 1" >/dev/null 2>&1; then
  psql -d postgres -tc "SELECT 1 FROM pg_roles WHERE rolname='hertz'" | grep -q 1 || \
    psql -d postgres -c "CREATE ROLE hertz WITH LOGIN PASSWORD 'hertz' CREATEDB;"
  createdb -O hertz hertz 2>/dev/null || true
fi

echo "==> [3/5] Installing dependencies..."
[ -d .venv ] || uv sync
[ -d frontend/node_modules ] || pnpm install

echo "==> [4/5] Running migrations..."
# 复数 heads：仓库为多 head 现状（wave26 主线 + wave21_glossary_remove 悬空分支），
# 单数 head 会被 alembic 直接拒绝（CommandError）。与 backend/entrypoint.py 同源（D-198）。
uv run alembic upgrade heads

echo "==> [5/5] Starting services..."
# 端口占用自动清理：残留进程会挡住本次启动（vite「Port 3000 already in use」、
# 后端 uvicorn「[Errno 48] Address already in use」）。
#
# 2026-09-30 实测补的这一段：原先只发一个 SIGTERM 就 `sleep 1`。但**卡死的 uvicorn
# 接得住 SIGTERM**——它走的是优雅退出，而优雅退出要事件循环还能转；转不动的进程
# 就永远不释放端口，于是本次启动的后端 bind 失败、脚本跟着把全家停掉，
# 现场只留下一句 `Address already in use` 和一个还在 LISTEN 的僵尸。
# 所以这里 TERM → 轮询等 → SIGKILL → 复查，最后仍占着就**报错退出**
# （比让后端无声崩掉好读，也省得人再去查端口）。
free_port() {
  local port="$1" pids parent child i
  pids=$(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null | tr '\n' ' ')
  [ -z "${pids// /}" ] && return 0
  echo "  Port $port in use (pid $pids) — stopping..."
  for i in 1 2 3 4 5 6; do
    kill $pids 2>/dev/null || true
    sleep 0.5
    pids=$(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null | tr '\n' ' ')
    [ -z "${pids// /}" ] && return 0
  done
  echo "  Port $port 没被 SIGTERM 停下（进程多半卡死）— 强杀，并连带它的启动包装进程"
  for child in $pids; do
    parent=$(ps -o ppid= -p "$child" 2>/dev/null | tr -d ' ')
    # 只杀「同一个命令族」的父进程（`uv run uvicorn` 会重生子进程，只杀子的是白杀）；
    # 父进程若是用户的 shell 就绝不碰。
    case "$(ps -o command= -p "$parent" 2>/dev/null)" in
      *uvicorn*|*vite*|*pnpm*) [ "${parent:-0}" -gt 1 ] && kill -9 "$parent" 2>/dev/null || true ;;
    esac
  done
  kill -9 $pids 2>/dev/null || true
  sleep 1
  pids=$(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null | tr '\n' ' ')
  if [ -n "${pids// /}" ]; then
    echo "  ✗ 端口 $port 仍被占用（pid $pids）——本次不启动，避免后端 bind 失败后连坐全家。"
    echo "    手动处理：kill -9 $pids"
    return 1
  fi
  return 0
}

for PORT in 3000 8787; do
  free_port "$PORT" || exit 1
done

cleanup() { kill 0 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# --reload（wave10.2）：后端代码改动自动热加载，避免旧进程无新路由导致 404
uv run uvicorn backend.main:app --port 8787 --reload &
BACKEND_PID=$!

(cd frontend && pnpm dev) &
FRONTEND_PID=$!

echo "Waiting for frontend on :3000..."
for i in $(seq 1 30); do
  curl -sf http://localhost:3000 >/dev/null 2>&1 && break
  sleep 0.5
done

(cd electron && pnpm dev) &
ELECTRON_PID=$!

echo "Backend :8787 (pid $BACKEND_PID) · Frontend :3000 (pid $FRONTEND_PID) · Electron (pid $ELECTRON_PID)"
echo "Press Ctrl+C to stop all."

# 任一服务退出（如 Dock 右键退出 Electron）→ 自动清理全部，防止后台残留
while true; do
  for pid in "$BACKEND_PID" "$FRONTEND_PID" "$ELECTRON_PID"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "Service (pid $pid) exited — stopping all..."
      exit 0
    fi
  done
  sleep 2
done
