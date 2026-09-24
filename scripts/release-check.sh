#!/bin/bash
# 发布前总闸（v0.32 S5）：源码级 + 产物级两道一起跑。
#
# 为什么需要它：v0.30–v0.32 的四个真实缺陷中三个绕过了 verify.sh
# （幽灵符号只在端点被调用时炸 / 依赖组与 spec blocklist 只在装机后缺 /
# env.py 的 import 只在冻结包里丢 / 单数 head 只在全新库首启挂）。
# 教训固化成一条规矩：**打 tag 之前必须跑完这个脚本**，全绿才允许 tag。
#
# 用法：
#   scripts/release-check.sh              # 源码门禁 → 重建固化包 → 产物门禁（默认档）
#   scripts/release-check.sh --with-asr   # 追加真音频转写与繁简断言
#   scripts/release-check.sh --full       # 再加本地 dmg 构建（不发版，--publish never）
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

MODE="${1:-}"
STAGE_FAILS=0

run() {  # run <名称> <命令...>：单独取退出码，绝不把管道状态当结论
  printf '\n\033[1m==> %s\033[0m\n' "$1"; shift
  "$@"
  local code=$?
  if [ "$code" = "0" ]; then printf '    ✓ 通过（exit 0）\n'; else printf '    ✗ 失败（exit %s）\n' "$code"; STAGE_FAILS=$((STAGE_FAILS + 1)); fi
  return 0
}

run "[1/4] 源码级门禁 verify.sh（ruff/pytest/tsc/vitest/vite）" ./scripts/verify.sh
run "[2/4] 重建固化后端（PyInstaller onedir）" ./scripts/build-backend.sh

if [ "$MODE" = "--full" ]; then
  run "[3/4] 本地打包（--dir + dmg，不发布）" \
    pnpm --filter hertz-electron run build -- --publish never
fi

SIM=(./scripts/sim-newmachine.sh)
[ "$MODE" = "--with-asr" ] && SIM+=(--with-asr)
run "[4/4] 产物级门禁（启动固化二进制：空库首启 / schema / API 契约 / 转写 / 进程守卫）" "${SIM[@]}"

printf '\n'
if [ "$STAGE_FAILS" = "0" ]; then
  printf '\033[1mRELEASE_CHECK: PASS\033[0m —— 可以打 tag（tag/push 仍需明确授权）\n'
  exit 0
fi
printf '\033[1mRELEASE_CHECK: FAIL\033[0m —— %s 个阶段未过，禁止打 tag\n' "$STAGE_FAILS"
exit 1
