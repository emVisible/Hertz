#!/bin/bash
# Hertz 产物级发布门禁 / 新机模拟（v0.32 S5）
#
# 为什么存在：v0.30–v0.32 期间四个真实缺陷里三个只有产物级才能发现——
#   · 函数级幽灵符号只在端点被调用时炸
#   · 可选依赖组与 spec blocklist 只在装机后缺能力
#   · alembic/env.py 的自研 import 只在冻结包里丢（数据文件不受静态分析）
#   · 单数 `alembic upgrade head` 只在全新库首启挂
# 源码级门禁（verify.sh）对上述全部无感。本脚本是第二道闸：**真的启动打包产物**。
#
# 用法：
#   scripts/sim-newmachine.sh            # 默认档：迁移/健康/契约/进程守卫，且保证不联网下载模型
#   scripts/sim-newmachine.sh --with-asr # 深度档：额外做真音频转写并断言输出非繁体
#   PORT=8899 scripts/sim-newmachine.sh  # 换端口（默认 8791；避开 8787 上的残留 dev 后端）
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

WITH_ASR=0
[ "${1:-}" = "--with-asr" ] && WITH_ASR=1

VERSION="$(grep -E '^APP_VERSION' backend/config.py | sed -E 's/.*"([^"]+)".*/\1/')"
BIN="${HERTZ_BUNDLE_BIN:-$ROOT/electron/backend-dist/hertz-backend/hertz-backend}"
PORT="${PORT:-8791}"
SIM_DB="hertz_sim_${VERSION//./_}"
DATA="$(mktemp -d "${TMPDIR:-/tmp}/hertz-sim-$VERSION.XXXXXX")"
LOG="$DATA/backend.log"
FAILURES=0

note() { printf '%s\n' "$*"; }
ok()   { printf '  ✓ %s\n' "$*"; }
bad()  { printf '  ✗ %s\n' "$*"; FAILURES=$((FAILURES + 1)); }
skip() { printf '  - %s\n' "$*"; }

cleanup() {
  [ -n "${BPID:-}" ] && kill "$BPID" 2>/dev/null
  sleep 1
  [ -n "${BPID:-}" ] && kill -9 "$BPID" 2>/dev/null
  uv run --project "$ROOT" python - "$SIM_DB" <<'PY' >/dev/null 2>&1
import asyncio, sys, asyncpg
async def m():
    c = await asyncpg.connect('postgresql://hertz@localhost:5432/postgres')
    await c.execute("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1", sys.argv[1])
    await c.execute(f'DROP DATABASE IF EXISTS "{sys.argv[1]}"')
    await c.close()
asyncio.run(m())
PY
  rm -rf "$DATA"
}
trap cleanup EXIT INT TERM

note "=== Hertz 产物级门禁 v$VERSION（端口 $PORT，隔离库 $SIM_DB） ==="

if [ ! -x "$BIN" ]; then
  bad "固化后端二进制缺失：$BIN —— 先跑 scripts/build-backend.sh"
  note "SIM_RESULT: FAIL"; exit 1
fi
ok "固化二进制就位（$(du -sh "$(dirname "$BIN")" | cut -f1)）"

# ---------- 1. 全新库全量迁移（装机路径） ----------
uv run --project "$ROOT" python - "$SIM_DB" <<'PY' >/dev/null 2>&1
import asyncio, sys, asyncpg
async def m():
    c = await asyncpg.connect('postgresql://hertz@localhost:5432/postgres')
    await c.execute("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1", sys.argv[1])
    await c.execute(f'DROP DATABASE IF EXISTS "{sys.argv[1]}"')
    await c.execute(f'CREATE DATABASE "{sys.argv[1]}"')
    await c.close()
asyncio.run(m())
PY

export HERTZ_DATABASE_URL="postgresql+asyncpg://hertz@localhost:5432/$SIM_DB"
export HERTZ_DATA_DIR="$DATA"
export HERTZ_BACKEND_PORT="$PORT"

"$BIN" > "$LOG" 2>&1 &
BPID=$!

READY=""
for i in $(seq 1 80); do
  sleep 3
  kill -0 "$BPID" 2>/dev/null || break
  if curl -s -m 3 "http://127.0.0.1:$PORT/api/health" | grep -q '"database"'; then READY=1; break; fi
done
if [ -n "$READY" ]; then
  ok "首启就绪 ~$((i * 3))s：建库 + 全量迁移 + 服务起来（v0.31 两次崩溃都在这一段）"
else
  bad "固化后端未就绪或提前退出；日志尾部："
  tail -12 "$LOG" | sed 's/^/      /'
fi

if [ -n "$READY" ]; then
  # 期望终点取自**仓库**的 alembic heads（不写死版本号）：包内少带迁移时这里就会失配
  EXPECTED_HEADS=$(cd "$ROOT" && uv run alembic heads 2>/dev/null | awk '{print $1}' | sort | paste -sd, -)
  # ---------- 2. 迁移终点与关键 schema（SQL 直查，不信日志） ----------
  SCHEMA_OUT=$(uv run --project "$ROOT" python - "$SIM_DB" <<'PY'
import asyncio, sys, asyncpg
async def m():
    c = await asyncpg.connect(f'postgresql://hertz@localhost:5432/{sys.argv[1]}')
    heads = sorted(r['v'] for r in await c.fetch('SELECT version_num v FROM alembic_version'))
    pri = await c.fetchval("SELECT 1 FROM information_schema.columns WHERE table_name='items' AND column_name='priority'")
    sp = await c.fetchval("SELECT to_regclass('public.style_presets')")
    fk = await c.fetchval("SELECT 1 FROM pg_constraint WHERE conname='plans_brief_group_id_fkey'")
    print(f"HEADS={','.join(heads)}")
    print(f"PRIORITY={'y' if pri else 'n'} STYLE_PRESETS={'y' if sp else 'n'} FK={'y' if fk else 'n'}")
    await c.close()
asyncio.run(m())
PY
)
  note "  $SCHEMA_OUT" | sed 's/^  HEADS=/  迁移终点：/'
  note "  仓库期望 head：$EXPECTED_HEADS"
  case "$SCHEMA_OUT" in
    *"HEADS=$EXPECTED_HEADS"*) ok "新库迁移终点与仓库一致（悬空分支按定档保持原样）" ;;
    *) bad "新库迁移终点与仓库不符——多半是固化包构建早于最新迁移，重跑 scripts/build-backend.sh" ;;
  esac
  case "$SCHEMA_OUT" in
    *PRIORITY=y*STYLE_PRESETS=y*FK=y*) ok "新库 schema 齐：items.priority / style_presets / brief_group FK" ;;
    *) bad "新库 schema 缺失（见上一行）" ;;
  esac

  # ---------- 3. 健康与 pipeline API 契约 ----------
  HEALTH=$(curl -s -m 8 "http://127.0.0.1:$PORT/api/health" 2>/dev/null)
  echo "$HEALTH" | grep -q '"database":{"status":"ok"}' && ok "health: database ok" || bad "health 数据库检查未通过"
  echo "$HEALTH" | grep -q "\"version\":\"$VERSION\"" \
    && ok "产物回读版本 $VERSION（版本标记真的进了包）" || bad "产物版本与期望 $VERSION 不符"
  for P in "/api/pipeline/items?limit=1" "/api/pipeline/items/counts" "/api/channels"; do
    C=$(curl -s -m 10 -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT$P")
    [ "$C" = "200" ] && ok "$P → 200" || bad "$P → $C"
  done

  # ---------- 4. 转写端点：先探可用性，绝不隐式下载模型 ----------
  WHISPER_STATUS=$(curl -s -m 8 "http://127.0.0.1:$PORT/api/deps" 2>/dev/null \
    | uv run --project "$ROOT" python -c "
import json,sys
d=json.load(sys.stdin)
items = d.get('dependencies') or d.get('tools') or d
w = items.get('whisper_model') or {}
print(w.get('status','unknown'))" 2>/dev/null)
  note "  whisper_model 能力矩阵状态：$WHISPER_STATUS"

  WAV=""
  if [ -x /usr/bin/say ] && command -v ffmpeg >/dev/null; then
    if /usr/bin/say -v Tingting -o "$DATA/d.aiff" "今天天气不错，我打算去公园里走走，顺便录一段语音草稿试试。" 2>/dev/null \
       || /usr/bin/say -o "$DATA/d.aiff" "Today is a good day to record a voice draft." 2>/dev/null; then
      ffmpeg -y -loglevel error -i "$DATA/d.aiff" -ar 16000 -ac 1 "$DATA/draft.wav" 2>/dev/null && WAV="$DATA/draft.wav"
    fi
  fi

  if [ -z "$WAV" ]; then
    skip "本地无法生成音频夹具（缺 say/ffmpeg）——转写断言未跑"
  elif [ "$WHISPER_STATUS" != "ok" ] && [ "$WITH_ASR" != "1" ]; then
    CODE=$(curl -s -m 60 -o "$DATA/tr.out" -w "%{http_code}" -F "file=@$WAV;type=audio/wav" \
      "http://127.0.0.1:$PORT/api/studio/transcribe")
    case "$CODE" in
      200) ok "转写 200（引擎与模型均可用）" ;;
      502) ok "转写 502：模型未就绪时给出明确指引，而非裸 500（幽灵符号类缺陷正是以 500 现形）；不隐式触发下载" ;;
      *)   bad "转写返回 $CODE，契约要求 200 或 502" ;;
    esac
  else
    CODE=$(curl -s -m 600 -o "$DATA/tr.json" -w "%{http_code}" -F "file=@$WAV;type=audio/wav" \
      "http://127.0.0.1:$PORT/api/studio/transcribe")
    if [ "$CODE" = "200" ]; then
      ok "转写 HTTP 200"
      if uv run --project "$ROOT" python - "$DATA/tr.json" <<'PY' >/dev/null 2>&1
import json, sys
from backend.pipeline.producers.asr import _has_traditional
d = json.load(open(sys.argv[1]))
t = d.get('text') or ''
assert t and not _has_traditional(t), f'输出为空或仍含繁体: {t}'
PY
      then ok "转写输出为简体（S3 在产物上成立）"; else bad "转写输出含繁体或为空"; fi
    else
      bad "转写 HTTP $CODE（深度档期望 200）：$(head -c 140 "$DATA/tr.json" 2>/dev/null)"
    fi
  fi

  # ---------- 5. 冻结体自我重跑守卫 ----------
  # 合法形态：后端主进程 + 至多一个 multiprocessing 助手；风暴形态是每次构造模型
  # 就把入口再跑一遍（v0.31 spike 实测 45s 内 1→7、观测累积 138 个残留进程）。
  sleep 2
  TOTAL=$(pgrep -f "backend-dist/hertz-backend" 2>/dev/null | wc -l | tr -d ' ')
  if [ "${TOTAL:-0}" -le 3 ]; then
    ok "无自我重跑风暴：hertz-backend 相关进程 $TOTAL 个"
  else
    bad "疑似冻结体自我重跑（$TOTAL 个进程）——查 entrypoint.freeze_support 与新依赖"
  fi
fi

if [ "$FAILURES" = "0" ]; then
  note "SIM_RESULT: PASS（v$VERSION，$([ "$WITH_ASR" = 1 ] && echo 深度档 || echo 默认档)）"
  exit 0
fi
note "SIM_RESULT: FAIL（$FAILURES 项未过）"
[ -s "$LOG" ] && { note "--- 后端日志尾部 ---"; tail -15 "$LOG"; }
exit 1
