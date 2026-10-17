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
#
# ⚠️ 端口自复活刹车（2026-10-17）
#
# 判据：**服务是不是"没我们管也自己回来了"**。观察到某个 pid 消失后给它一个
# 观察窗（STORM_GRACE 秒，足够覆盖几次重启），若它的端口又有人在听 → 有外部
# 东西在重启它 → 计数；达到 STORM_MAX 就打印诊断并以非 0 退出。没人拉的话端口
# 不会回来 → 保持原来的"整体退出"。正常退出行为不变。
#
# ⚠️ 上一版注释里写的"真实日志背景"是**误判，已经作废**：
# `logs/hertz.log` 里那 2806 次"后端启停"并不是运行时重启风暴，而是**测试自己**
# 在造 app——全量 pytest 每次实例化 app 都走一遍 lifespan，日志又没和测试隔离，
# 于是几百次测试全记在同一份生产日志里（实测每次 lifespan 只花 0.13s，且当天
# 08:19–08:52 的窗口与 verify 日志的写入时间逐分钟吻合；那段时间没有任何 .py
# 变动，而 uvicorn --reload 只在 .py 变化时才重启）。当时据此判定"有东西在重启
# 后端"，方向就错了。
#
# 这个刹车本身仍然留着：它是"重复启动 / 遗留包装进程"这类真实现象的兜底，
# 判据也不依赖那条误判的证据。但**别再拿 2806 当重启风暴的证据**——
# 先确认日志里的启动是应用自己打的还是测试打的（看时间是否与 pytest 吻合）。
STORM_WINDOW="${HERTZ_STORM_WINDOW:-120}"   # 计数窗口（秒）
STORM_MAX="${HERTZ_STORM_MAX:-3}"           # 窗口内判定的复活次数
STORM_GRACE="${HERTZ_STORM_GRACE:-10}"      # 单次观察窗（秒）
STORM_START=$(date +%s)
STORM_COUNT=0

port_alive() { lsof -ti "tcp:$1" -sTCP:LISTEN >/dev/null 2>&1; }

storm_report() { # $1=名字 $2=端口
  echo ""
  echo "✗ ${1}（:${2}）在 ${STORM_WINDOW}s 内复活 ${STORM_COUNT} 次（阈值 ${STORM_MAX}）——判定为重启风暴，停止全部服务。"
  echo "  含义：有别的东西在反复拉起它，本脚本退出也拦不住。"
  echo "  排查（只读命令）："
  echo "    lsof -nP -iTCP:${2} -sTCP:LISTEN          # 谁在占着端口"
  echo "    ps -Ao pid,ppid,command | grep -E 'uvicorn|hertz-backend|dev.sh|webui.sh'"
  echo "  最常见的一种：另一个 dev.sh / webui.sh 还在跑（重复启动），或遗留的启动包装进程。"
  echo "  调阈值：HERTZ_STORM_WINDOW=300 HERTZ_STORM_MAX=6 bash scripts/dev.sh"
}

# 返回 0 = 服务自己回来了（有外部东西在重启它）；1 = 确实死了
wait_for_respawn() { # $1=端口 $2=名字
  local waited=0
  while (( waited < STORM_GRACE )); do
    sleep 1
    waited=$(( waited + 1 ))
    if port_alive "$1"; then return 0; fi
  done
  echo "Service (${2}, pid 已退出) — stopping all..."
  return 1
}

# pid / 端口 的并行数组（bash 3.2 没有关联数组，用下标对齐）
PIDS=("$BACKEND_PID" "$FRONTEND_PID" "$ELECTRON_PID")
PORTS=(8787 3000 0)
NAMES=("后端 :8787" "前端 :3000" "Electron")

while true; do
  for i in 0 1 2; do
    pid="${PIDS[$i]}"
    kill -0 "$pid" 2>/dev/null && continue

    # Electron 没有端口可探：它退出就是退出，交给原来的整体清理
    if [[ "${PORTS[$i]}" == "0" ]]; then
      echo "Service (${NAMES[$i]}, pid $pid) exited — stopping all..."
      exit 0
    fi

    if wait_for_respawn "${PORTS[$i]}" "${NAMES[$i]}"; then
      NOW=$(date +%s)
      if (( NOW - STORM_START > STORM_WINDOW )); then STORM_START=$NOW; STORM_COUNT=0; fi
      STORM_COUNT=$(( STORM_COUNT + 1 ))
      echo "⚠ ${NAMES[$i]} 自己回来了（${STORM_COUNT}/${STORM_MAX} in ${STORM_WINDOW}s）——有东西在重启它"
      if (( STORM_COUNT >= STORM_MAX )); then
        storm_report "${NAMES[$i]}" "${PORTS[$i]}"
        exit 1
      fi
      continue
    fi
    exit 0
  done
  sleep 2
done
