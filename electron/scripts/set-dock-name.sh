#!/bin/bash
# Dev-mode branding: Electron.app ships CFBundleName=Electron and a default
# electron.icns. Hovering the dock icon shows "Electron"; the dock icon itself
# is the default Electron logo (dock.setIcon only overrides it while running —
# on quit / system dialogs macOS reads the bundle icon and flips back).
#
# This script rewrites both before launching:
#   - CFBundleName / CFBundleDisplayName -> Hertz
#   - Resources/electron.icns            -> build/icon.icns (Hertz logo)
# Idempotent: skips when already branded. Packaged builds are unaffected
# (electron-builder writes productName + icon into the .app).
ELECTRON_ROOT="$(cd "$(dirname "$0")/.." && pwd)/node_modules/electron/dist/Electron.app"
PLIST="$ELECTRON_ROOT/Contents/Info.plist"
ICON_SRC="$(cd "$(dirname "$0")/.." && pwd)/build/icon.icns"
ICON_DST="$ELECTRON_ROOT/Contents/Resources/electron.icns"

[ -f "$PLIST" ] || exit 0
[ -f "$ICON_SRC" ] || exit 0

CUR="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleName' "$PLIST" 2>/dev/null)"
if [ "$CUR" != "Hertz" ]; then
  /usr/libexec/PlistBuddy -c 'Set :CFBundleName Hertz' "$PLIST" 2>/dev/null
  /usr/libexec/PlistBuddy -c 'Set :CFBundleDisplayName Hertz' "$PLIST" 2>/dev/null
  echo "dock label: Electron -> Hertz"
fi

# 仅当 bundle 图标不是 Hertz 时替换（按文件哈希判断，幂等）
if [ -f "$ICON_DST" ]; then
  SRC_HASH="$(shasum -a 256 "$ICON_SRC" | awk '{print $1}')"
  DST_HASH="$(shasum -a 256 "$ICON_DST" | awk '{print $1}')"
  if [ "$SRC_HASH" != "$DST_HASH" ]; then
    cp "$ICON_SRC" "$ICON_DST"
    echo "dock icon: Electron default -> Hertz"
  fi
fi
