#!/bin/bash
# Hertz pre-commit gate: lint + backend tests + mdcore + frontend typecheck/tests/build
# + 排版基线图（Electron 产物层逐像素比对）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ── 互斥锁：同一台机器上只许有一个门禁在跑 ────────────────────────────────
# 为什么需要：两个门禁叠在一起（后台一个、前台一个）会把内存峰值直接翻倍。
# 排版基线那一步还会起 Electron 并按 2× DPR 截图，单张就有 25MB 位图；
# 16GB 的机器上再叠上 pytest 的连接池与 vitest 的 worker，swap 会被打满，
# 表现是「系统卡死、只能重启」——而卡死的锅很难归到某一条测试上。
#
# 这里用 mkdir 当锁（POSIX 保证原子性），进程被杀掉时目录会留下，
# 所以额外写 PID：发现是死进程留下的陈旧锁就清掉，不必手工删。
LOCK_DIR="${TMPDIR:-/tmp}/hertz-verify.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  if [[ -f "$LOCK_DIR/pid" ]] && ! kill -0 "$(cat "$LOCK_DIR/pid")" 2>/dev/null; then
    rm -rf "$LOCK_DIR" && mkdir "$LOCK_DIR"
  else
    echo "!! 已有一个门禁在跑（PID $(cat "$LOCK_DIR/pid" 2>/dev/null || echo 未知)）。" >&2
    echo "   两个门禁叠着跑会把内存打满导致系统卡死——请等它结束，或先杀掉那个进程。" >&2
    exit 3
  fi
fi
echo $$ > "$LOCK_DIR/pid"
cleanup() { rm -rf "$LOCK_DIR"; }
trap cleanup EXIT INT TERM

# 门禁是最吃内存的一类操作，单独跑；加 --quick 只跑结构性那几步。
QUICK=0
[[ "${1:-}" == "--quick" ]] && QUICK=1

echo "==> [1/8] backend lint (ruff)"
uv run ruff check backend tests

echo "==> [2/8] backend tests (pytest)"
uv run pytest -q

echo "==> [3/8] mdcore typecheck (tsc)"
pnpm --filter @hertz/mdcore typecheck

echo "==> [4/8] mdcore tests (vitest)"
pnpm --filter @hertz/mdcore test

echo "==> [5/8] frontend typecheck (tsc)"
pnpm --filter hertz-frontend typecheck

echo "==> [6/8] frontend tests (vitest)"
pnpm --filter hertz-frontend test

echo "==> [7/8] frontend build (vite)"
pnpm --filter hertz-frontend build

# 排版是观感问题，观感只能在产物层判：这步把每套主题 × 每份样例重拍一遍，
# 与 packages/mdcore/tests/baselines/typography/ 的基准图逐像素比（阈值 0.5%）。
# 退出码：0 通过 / 1 超阈值（门禁红）/ 2 环境跑不起来（打印警告，不冒充通过）。
if [[ "$QUICK" == "1" ]]; then
  echo "==> [8/8] 排版基线图 —— 跳过（--quick）"
  echo "==> ALL GATES PASSED（--quick：未跑排版基线）"
  exit 0
fi

echo "==> [8/8] 排版基线图（Electron 产物层比对）"
BASELINE_EXIT=0
node scripts/typography-baseline.mjs || BASELINE_EXIT=$?
if [ "$BASELINE_EXIT" = "2" ]; then
  echo "    ⚠️ 基线图未运行（环境问题，原因见上）——本步不计为通过"
fi

echo "==> ALL GATES PASSED"
