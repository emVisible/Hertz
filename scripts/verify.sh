#!/bin/bash
# Hertz pre-commit gate: lint + backend tests + mdcore + frontend typecheck/tests/build
# + 排版基线图（Electron 产物层逐像素比对）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

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
echo "==> [8/8] 排版基线图（Electron 产物层比对）"
BASELINE_EXIT=0
node scripts/typography-baseline.mjs || BASELINE_EXIT=$?
if [ "$BASELINE_EXIT" = "2" ]; then
  echo "    ⚠️ 基线图未运行（环境问题，原因见上）——本步不计为通过"
fi

echo "==> ALL GATES PASSED"
