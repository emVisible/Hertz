#!/bin/bash
# Hertz pre-commit gate: lint + backend tests + mdcore + frontend typecheck/tests/build.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> [1/7] backend lint (ruff)"
uv run ruff check backend tests

echo "==> [2/7] backend tests (pytest)"
uv run pytest -q

echo "==> [3/7] mdcore typecheck (tsc)"
pnpm --filter @hertz/mdcore typecheck

echo "==> [4/7] mdcore tests (vitest)"
pnpm --filter @hertz/mdcore test

echo "==> [5/7] frontend typecheck (tsc)"
pnpm --filter hertz-frontend typecheck

echo "==> [6/7] frontend tests (vitest)"
pnpm --filter hertz-frontend test

echo "==> [7/7] frontend build (vite)"
pnpm --filter hertz-frontend build

echo "==> ALL GATES PASSED"
