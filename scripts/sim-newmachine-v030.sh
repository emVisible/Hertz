#!/bin/bash
# v0.30 新机模拟：隔离数据库 + 隔离数据目录，跑打包后的固化后端二进制。
# 验收点：alembic 多 head 下迁移全量跑通 / health database ok / pipeline API 通 /
#         style_presets 表与 items.priority 列在新鲜库上真实存在。
set -uo pipefail

ROOT="/Users/young/Code/Hertz"
SIM_DB="hertz_sim_v030"
DATA="/tmp/hertz_sim_v030_data"
PORT=8791
BIN="$ROOT/electron/release/mac-arm64/Hertz.app/Contents/Resources/backend/hertz-backend"

rm -rf "$DATA"; mkdir -p "$DATA"

# 陈旧模拟库先删掉（幂等重跑）
uv run --project "$ROOT" python - <<'PY'
import asyncio, asyncpg
async def main():
    c = await asyncpg.connect('postgresql://hertz@localhost:5432/postgres')
    await c.execute("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='hertz_sim_v030'")
    await c.execute('DROP DATABASE IF EXISTS "hertz_sim_v030"')
    print("dropped stale sim db (if any)")
    await c.close()
asyncio.run(main())
PY

export HERTZ_DATABASE_URL="postgresql+asyncpg://hertz@localhost:5432/$SIM_DB"
export HERTZ_DATA_DIR="$DATA"
export HERTZ_BACKEND_PORT="$PORT"

echo "=== launching frozen backend: $BIN ==="
"$BIN" > /tmp/hertz_sim_v030_backend.log 2>&1 &
BPID=$!

echo "=== waiting for /api/health (cold start ~20-70s, D-185) ==="
OK=""
for i in $(seq 1 60); do
  if ! kill -0 $BPID 2>/dev/null; then echo "PROCESS DIED after ${i}x2s"; break; fi
  H=$(curl -s -m 3 "http://127.0.0.1:$PORT/api/health" || true)
  if echo "$H" | grep -q '"database"'; then echo "HEALTH: $H"; OK=1; break; fi
  sleep 2
done

if [ -n "$OK" ]; then
  echo "=== pipeline API 抽查 ==="
  for P in "/api/health" "/api/items?limit=1" "/api/style-presets" "/api/pipeline/queue?stage=all"; do
    CODE=$(curl -s -m 8 -o /tmp/hertz_sim_resp.json -w "%{http_code}" "http://127.0.0.1:$PORT$P")
    echo "$P -> HTTP $CODE | $(head -c 140 /tmp/hertz_sim_resp.json)"
  done
  echo "=== 新鲜库 schema 核验（wave25 style_presets / wave26 priority / alembic_version） ==="
  uv run --project "$ROOT" python - <<'PY'
import asyncio, asyncpg
async def main():
    c = await asyncpg.connect('postgresql://hertz@localhost:5432/hertz_sim_v030')
    print("alembic_version rows:", sorted(await c.fetch("SELECT version_num FROM alembic_version") and [r['version_num'] for r in await c.fetch("SELECT version_num FROM alembic_version")]))
    print("style_presets exists:", bool(await c.fetchval("SELECT to_regclass('public.style_presets')")))
    print("items.priority col:", await c.fetchval("SELECT column_name FROM information_schema.columns WHERE table_name='items' AND column_name='priority'"))
    print("items.priority default ok:", await c.fetchval("SELECT column_default FROM information_schema.columns WHERE table_name='items' AND column_name='priority'"))
    print("total tables:", await c.fetchval("SELECT count(*) FROM information_schema.tables WHERE table_schema='public'"))
    await c.close()
asyncio.run(main())
PY
fi

echo "=== shutdown + cleanup ==="
kill $BPID 2>/dev/null; sleep 2; kill -9 $BPID 2>/dev/null
lsof -nP -iTCP:$PORT -sTCP:LISTEN 2>/dev/null || echo "port $PORT released"
tail -25 /tmp/hertz_sim_v030_backend.log
echo "SIM_DONE"
