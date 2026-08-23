#!/bin/bash
# Hertz 后端固化（v0.21 P0）：PyInstaller onedir → electron/backend-dist/hertz-backend/
# 产物由 electron-builder extraResources 收进 app（electron/package.json）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> PyInstaller backend (onedir)"
uv run pyinstaller hertz.spec \
  --noconfirm \
  --distpath electron/backend-dist \
  --workpath build/pyinstaller

echo "==> Backend bundle ready: electron/backend-dist/hertz-backend"
du -sh electron/backend-dist/hertz-backend
