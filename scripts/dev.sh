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
uv run alembic upgrade head

echo "==> [5/5] Starting services..."
# 端口占用自动清理：残留进程会挡住本次启动（vite "Port 3000 already in use"）
for PORT in 3000 8787; do
  PIDS=$(lsof -ti tcp:$PORT 2>/dev/null || true)
  if [ -n "$PIDS" ]; then
    echo "  Port $PORT in use (pid $PIDS) — stopping..."
    kill $PIDS 2>/dev/null || true
    sleep 1
  fi
done

cleanup() { kill 0 2>/dev/null || true; }
trap cleanup EXIT INT TERM

uv run uvicorn backend.main:app --port 8787 &
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

wait
