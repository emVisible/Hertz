#!/bin/bash
# Dev-mode Dock label: Electron.app ships CFBundleName=Electron, so hovering
# the dock icon shows "Electron". Rewrite it to "Hertz" before launching.
# Idempotent: skips when already set. Packaged builds are unaffected
# (electron-builder writes the real product name into the .app).
PLIST="$(cd "$(dirname "$0")/.." && pwd)/node_modules/electron/dist/Electron.app/Contents/Info.plist"
[ -f "$PLIST" ] || exit 0
CUR="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleName' "$PLIST" 2>/dev/null)"
if [ "$CUR" != "Hertz" ]; then
  /usr/libexec/PlistBuddy -c 'Set :CFBundleName Hertz' "$PLIST" 2>/dev/null
  /usr/libexec/PlistBuddy -c 'Set :CFBundleDisplayName Hertz' "$PLIST" 2>/dev/null
  echo "dock label: Electron -> Hertz"
fi
