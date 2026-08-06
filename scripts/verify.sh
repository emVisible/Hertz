#!/bin/bash
# Hertz pre-commit gate: lint + backend tests + frontend typecheck/tests/build.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> [1/5] backend lint (ruff)"
uv run ruff check backend tests

echo "==> [2/5] backend tests (pytest)"
uv run pytest -q

echo "==> [3/5] frontend typecheck (tsc)"
pnpm --filter hertz-frontend typecheck

echo "==> [4/5] frontend tests (vitest)"
pnpm --filter hertz-frontend test

echo "==> [5/5] frontend build (vite)"
pnpm --filter hertz-frontend build

echo "==> ALL GATES PASSED"
