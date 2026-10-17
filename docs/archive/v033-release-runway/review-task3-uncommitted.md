# Task 3 review package (UNCOMMITTED working tree vs 1f4f348)

## stat
 backend/infrastructure/deps.py                     | 32 ++++++++++++++++++++++
 backend/routers/pipeline_ops.py                    | 26 +++++++++++++++++-
 docs/API_INVENTORY.md                              |  1 +
 .../src/pages/settings/sections/settingsCards.tsx  |  4 +--
 4 files changed, 60 insertions(+), 3 deletions(-)

## new untracked test file: tests/test_reddit_auth_card.py
```python
"""Reddit 凭证必须是「能看见的状态」，不是「有时能用有时不能」。

现状（实测）：`pipeline_reddit_client_id` 为空 → `ensure_reddit_token()` 返回 None
→ v0.3.7 的签名直链兜底从未启用，而界面上没有任何地方说这件事。用户只看到
「下载偶尔 403」。D-190 的四件套就是为这类静默降级立的规矩。

本片只补**可见性**（矩阵条目 + 显示名 + 可 probe 的状态端点），不修 403：
凭证得用户自己去 reddit.com/prefs/apps 建。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from backend.config import settings
from backend.infrastructure import deps

ROOT = Path(__file__).resolve().parents[1]
CARDS_TSX = ROOT / "frontend/src/pages/settings/sections/settingsCards.tsx"


def _unconfigured(monkeypatch) -> None:
    monkeypatch.setattr(settings, "pipeline_reddit_client_id", "")
    monkeypatch.setattr(settings, "pipeline_reddit_client_secret", "")


def _configured(monkeypatch) -> None:
    monkeypatch.setattr(settings, "pipeline_reddit_client_id", "cid")
    monkeypatch.setattr(settings, "pipeline_reddit_client_secret", "sec")


# ---------- 能力矩阵条目（D-190 第 2 件）----------


def test_reddit_auth_card_off_when_unconfigured(monkeypatch) -> None:
    """没配凭证要能说「没配」并且给出路——只说没配等于把人留在原地。"""
    _unconfigured(monkeypatch)
    card = deps._check_reddit_auth()
    assert card["status"] == "off"
    # install_hint 是 DepsCard 非 ok 行唯一渲染的出路字段（status==ok 或无 hint 就不渲染）
    assert "设置" in card["install_hint"]


def test_reddit_auth_card_ok_when_configured(monkeypatch) -> None:
    _configured(monkeypatch)
    assert deps._check_reddit_auth()["status"] == "ok"


@pytest.mark.asyncio
async def test_card_registered_in_matrix_and_rendered(client, monkeypatch) -> None:
    """D-190 四件套里「界面看得见」的两条腿：矩阵有条目 + 显示名与渲染行都在。

    矩阵有条目但 LABELS 没名字 → 界面上是一串裸 key；LABELS 有名字但不在 rows
    里 → 条目压根不被渲染（rows 才是渲染清单）。两种都等于用户看不见。
    """
    _unconfigured(monkeypatch)
    matrix = await deps.check_dependencies()
    assert "reddit_auth" in matrix

    # DepsCard 取的是缓存 GET /api/deps——条目进不了这个响应，界面上就没有这张卡
    await client.post("/api/deps/check")
    assert "reddit_auth" in (await client.get("/api/deps")).json()

    text = CARDS_TSX.read_text(encoding="utf-8")
    labels_src = text[text.index("const LABELS"): text.index("const rows")]
    rows_src = text[text.index("const rows"):]
    assert "reddit_auth:" in labels_src, "能力矩阵有条目但界面无显示名 = 用户永远看不到"
    assert "'reddit_auth'" in rows_src, "有显示名但不在渲染清单里 = 一样不出现"


# ---------- 退化告警：新卡不得刷屏，但配好又掉了必须说 ----------


def test_card_starting_off_is_silent_but_losing_creds_alerts() -> None:
    """`_diff_degradation` 只认 ok→非 ok：从未配过的用户不会每天被推一条「你没配」。

    反过来，填完凭证又被清空（改配置/换机器丢 runtime.yaml）是真退化，要说。
    """
    off = {"reddit_auth": {"status": "off", "detail": "x"}}
    ok = {"reddit_auth": {"status": "ok", "detail": "签名直链兜底已启用"}}
    assert deps._diff_degradation(off, off) == []
    assert deps._diff_degradation(None, off) == []  # 首次建基线不告警
    assert deps._diff_degradation(off, ok) == []
    assert any("reddit_auth" in line for line in deps._diff_degradation(ok, off))


# ---------- 状态端点：填完凭证能自己验，不用去猜 ----------

OFF_HINT = "在 reddit.com/prefs/apps 建 script 应用后填进设置"


def _forbid_network(monkeypatch) -> None:
    """任何一次真取 token 都算失败：设置页每次渲染都打这个端点，不能顺手联网。"""

    async def _boom() -> str | None:
        raise AssertionError("reddit-auth/status 默认不得调 ensure_reddit_token")

    monkeypatch.setattr("backend.pipeline.collectors.reddit.ensure_reddit_token", _boom)


@pytest.mark.asyncio
async def test_status_endpoint_reports_unconfigured_without_network(
    client, monkeypatch
) -> None:
    _unconfigured(monkeypatch)
    _forbid_network(monkeypatch)
    r = await client.get("/api/pipeline/reddit-auth/status")
    assert r.status_code == 200
    assert r.json() == {"configured": False, "token_ok": None, "hint": OFF_HINT}


@pytest.mark.asyncio
async def test_status_endpoint_needs_opt_in_to_probe(client, monkeypatch) -> None:
    """凭证填好了也不自动联网：只有 probe=true 才真取 token。"""
    _configured(monkeypatch)
    _forbid_network(monkeypatch)
    body = (await client.get("/api/pipeline/reddit-auth/status")).json()
    assert body["configured"] is True
    assert body["token_ok"] is None
    assert body["hint"] == ""


@pytest.mark.asyncio
async def test_status_endpoint_probe_true_actually_takes_token(client, monkeypatch) -> None:
    _configured(monkeypatch)

    async def _fake() -> str | None:
        return "t-abc"

    monkeypatch.setattr("backend.pipeline.collectors.reddit.ensure_reddit_token", _fake)
    body = (await client.get("/api/pipeline/reddit-auth/status", params={"probe": "true"})).json()
    assert body == {"configured": True, "token_ok": True, "hint": ""}


@pytest.mark.asyncio
async def test_status_endpoint_probe_failure_is_readable_not_500(
    client, monkeypatch
) -> None:
    """填错 secret 时 OAuth 抛 RuntimeError——端点炸成裸 500 等于没说。

    「我问过并且失败」和「我没问」是两件事：前者要退成 token_ok=false + 出路。
    """
    _configured(monkeypatch)

    async def _wrong() -> str | None:
        raise RuntimeError("Reddit OAuth 换取 token 失败 (HTTP 401)——"
                           "请检查设置页的 client_id/client_secret")

    monkeypatch.setattr("backend.pipeline.collectors.reddit.ensure_reddit_token", _wrong)
    r = await client.get("/api/pipeline/reddit-auth/status?probe=true")
    assert r.status_code == 200
    body = r.json()
    assert body["configured"] is True and body["token_ok"] is False
    assert "client_id" in body["hint"]


# ---------- 一份事实一个作者 ----------


def test_configured_judgment_has_a_single_author() -> None:
    """`configured` 判据只写在 `deps.reddit_credentials_configured()` 里。

    端点自己再 `bool(id and secret)` 一遍就是第二个作者——两边对「填了空格算不算」
    的理解迟早漂移，届时矩阵说 ok、端点说没配，用户看到的还是自相矛盾的两行字。
    """
    router_src = (ROOT / "backend/routers/pipeline_ops.py").read_text(encoding="utf-8")
    assert "reddit_credentials_configured" in router_src, "端点没消费唯一作者，八成是重写了一遍"
    assert "pipeline_reddit_client_secret" not in router_src, "判据在端点里第二次出现"


def test_card_delegates_to_the_shared_judgment(monkeypatch) -> None:
    """矩阵条目也必须走同一个 helper，而不是自己再数一遍字段。"""
    monkeypatch.setattr(deps, "reddit_credentials_configured", lambda: True)
    monkeypatch.setattr(settings, "pipeline_reddit_client_id", "")
    monkeypatch.setattr(settings, "pipeline_reddit_client_secret", "")
    assert deps._check_reddit_auth()["status"] == "ok"

```

## diff
diff --git a/backend/infrastructure/deps.py b/backend/infrastructure/deps.py
index 071e3e6..3001f0b 100644
--- a/backend/infrastructure/deps.py
+++ b/backend/infrastructure/deps.py
@@ -215,26 +215,57 @@ def _check_telegram_cfg() -> dict:
     chat_id = str(getattr(app_settings, "telegram_chat_id", "") or "").strip()
     if token and chat_id:
         return {"status": "ok"}
     return {
         "status": "error",
         "detail": "已启用但 token/chat_id 不完整",
         "install_hint": "设置 → Telegram 补全配置",
     }
 
 
+def reddit_credentials_configured() -> bool:
+    """Reddit OAuth 凭证齐不齐——**这条判据的唯一作者**。
+
+    id 与 secret 必须都非空才谈得上签名直链（只填一半，OAuth 换 token 会 401）。
+    能力矩阵条目与 `GET /api/pipeline/reddit-auth/status` 都读这里：判据在第二处
+    重写就会漂移成「矩阵说 ok、端点说没配」。
+    """
+    return bool(
+        str(getattr(settings, "pipeline_reddit_client_id", "") or "").strip()
+        and str(getattr(settings, "pipeline_reddit_client_secret", "") or "").strip()
+    )
+
+
+def _check_reddit_auth() -> dict:
+    """Reddit OAuth 凭证（决定 v.redd.it 被 403 时能否走签名直链）。
+
+    为什么单列一条：`ensure_reddit_token()` 未配置时直接返回 None，签名直链兜底
+    「从未生效」这件事在界面上完全不可见——用户体感只是「下载偶尔失败」，
+    正是 D-190 要消灭的静默形状。它是可选能力（匿名通道可用），故只报不阻断。
+    """
+    if reddit_credentials_configured():
+        return {"status": "ok", "detail": "签名直链兜底已启用"}
+    return {
+        "status": "off",
+        "detail": "未配置凭证：v.redd.it 被 CDN 403 时无签名直链可用",
+        "install_hint": "设置 → 流水线 → Reddit 采集（建 script 应用后填 client id/secret）",
+    }
+
+
 
 # ── 新增可选能力四件套（D-190 约定，防静默降级复发）──────────────
 # 1. pyproject 可选依赖组或主依赖（轻量核心能力直接进主依赖）
 # 2. 本文件注册检查条目（结构 {status, detail?, install_hint?}，
 #    status ∈ ok / missing / pending / off / error）
 # 3. preflight.plan_capability_checks 映射生产方式 → 阻断/警告
+#    （仅制作期能力；plan_capability_checks 的入参是 produce 开关，
+#     采集/下载期能力如 telegram、reddit_auth 无处可映射=不阻断，只报）
 # 4. DepsCard LABELS 加显示名
 # 缺任何一件 = 下一个「制作到一半才发现」事故。
 # ──────────────────────────────────────────────────────────────
 
 
 async def check_dependencies() -> dict:
     """全量检测（仅启动/手动触发时执行——运行时不再调用）。
 
     每项携带 install_hint（缺失/降级时的安装指引）——设置页直接展示，
     单一真相源在后端（§22.2 用户语言化：安装命令随检测逻辑维护）。
@@ -251,20 +282,21 @@ async def check_dependencies() -> dict:
         "edge-tts": _check_module(
             "edge_tts",
             "uv pip install edge-tts",
         ),
         "font": _check_subtitle_font(),
         # v0.22.x 能力矩阵扩展：可选能力使用前可见（D-190）
         "local_mt": await _check_local_mt(),
         "whisper_model": _check_whisper_model(),
         "llm": await _check_llm_registry(),
         "telegram": _check_telegram_cfg(),
+        "reddit_auth": _check_reddit_auth(),
     }
 
 
 def _subtitle_font_paths() -> list[Path]:
     """字幕字体候选（v0.11.2）：assets 优先，系统字体目录兜底（fontconfig/libass 可识别）。"""
     from backend.config import settings
 
     candidates: list[Path] = []
     for name in ("LXGWWenKai-Regular.ttf",):
         candidates.append(Path(settings.data_dir) / "assets" / "fonts" / name)
diff --git a/backend/routers/pipeline_ops.py b/backend/routers/pipeline_ops.py
index f35c939..5202a3f 100644
--- a/backend/routers/pipeline_ops.py
+++ b/backend/routers/pipeline_ops.py
@@ -1,11 +1,11 @@
-"""运维域：任务历史/采集源/失败分类/排期/模板/Reddit cookie。
+"""运维域：任务历史/采集源/失败分类/排期/模板/Reddit cookie 与 OAuth 凭证状态。
 
 v0.8.9 AXIOM 2.1 路由域拆分：原 pipeline.py 30+ 端点 7 域挤一文件，
 按用户可感知域拆出；路径与语义不变（pipeline_ops.router 由 pipeline 聚合 include）。
 """
 
 import logging
 import uuid
 
 from fastapi import APIRouter, HTTPException, Query
 from pydantic import BaseModel
@@ -68,20 +68,44 @@ async def _verify_reddit_channel(cookie: str | None) -> dict:
         ) as client:
             resp = await client.get(
                 "https://www.reddit.com/r/AmItheAsshole/hot.json",
                 params={"limit": 1, "raw_json": 1},
             )
             return {"code": resp.status_code, "ok": resp.status_code == 200}
     except httpx.HTTPError as exc:
         return {"ok": False, "error": exc.__class__.__name__}
 
 
+@router.get("/reddit-auth/status")
+async def reddit_auth_status(probe: bool = False) -> dict:
+    """Reddit OAuth 凭证状态：是否已配 + 可选的 token 真取（probe=true 才联网）。
+
+    默认不联网——设置页每次渲染都打这里，顺手 probe 会被 Reddit 限流；用户填完
+    凭证自己点一次验证。`configured` 读 `deps.reddit_credentials_configured()`
+    （判据唯一作者，别在这里再数一遍字段）；「能不能真取到 token」仍由
+    `ensure_reddit_token()` 回答，端点只做搬运。
+    """
+    from backend.infrastructure.deps import reddit_credentials_configured
+    from backend.pipeline.collectors.reddit import ensure_reddit_token
+
+    configured = reddit_credentials_configured()
+    hint = "" if configured else "在 reddit.com/prefs/apps 建 script 应用后填进设置"
+    token_ok: bool | None = None
+    if configured and probe:
+        try:
+            token_ok = bool(await ensure_reddit_token())
+        except Exception as exc:  # noqa: BLE001 — 取不到 token 是答案不是崩溃，退成 false
+            token_ok = False
+            hint = f"取 token 失败：{exc}"
+    return {"configured": configured, "token_ok": token_ok, "hint": hint}
+
+
 @router.get("/collect/status")
 async def collect_status() -> dict:
     """采集运维状态（v0.8.2）：运行中/上次结果/下次自动/间隔。"""
     return await _pipe().collect_status()
 
 
 class TemplateBody(BaseModel):
     name: str
     options: dict
 
diff --git a/docs/API_INVENTORY.md b/docs/API_INVENTORY.md
index d183ed7..931641e 100644
--- a/docs/API_INVENTORY.md
+++ b/docs/API_INVENTORY.md
@@ -196,20 +196,21 @@
 `POST /api/pipeline/items/{item_id}/score`
 `GET /api/pipeline/jobs`
 `GET /api/pipeline/jobs/{job_id}`
 `POST /api/pipeline/produce-options`
 `GET /api/pipeline/produce-templates`
 `POST /api/pipeline/produce-templates`
 `DELETE /api/pipeline/produce-templates/{template_id}`
 `PUT /api/pipeline/produce-templates/{template_id}`
 `GET /api/pipeline/publish/queue`
 `GET /api/pipeline/publish/status`
+`GET /api/pipeline/reddit-auth/status`
 `POST /api/pipeline/reddit-cookie/export`
 `GET /api/pipeline/reddit-cookie/status`
 `POST /api/pipeline/reschedule-expired`
 `POST /api/pipeline/retry-class`
 `POST /api/pipeline/run`
 `GET /api/pipeline/schedule/next`
 `GET /api/pipeline/sources`
 `GET /api/pipeline/status`
 `GET /api/pipeline/steps`
 `GET /api/pipeline/supply`
diff --git a/frontend/src/pages/settings/sections/settingsCards.tsx b/frontend/src/pages/settings/sections/settingsCards.tsx
index 58c640e..34a400b 100644
--- a/frontend/src/pages/settings/sections/settingsCards.tsx
+++ b/frontend/src/pages/settings/sections/settingsCards.tsx
@@ -102,25 +102,25 @@ export function DepsCard() {
       toast(err instanceof Error ? err.message : String(err), 'error')
     }
   }
 
   // v0.8.9：安装指引由后端检测结果提供（install_hint，单一真相源）
   // v0.22.x 能力矩阵：label 映射 + pending 琥珀态（待下载/未知，非错误）
   const LABELS: Record<string, string> = {
     ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', biliup: 'biliup',
     'yt-dlp': 'yt-dlp', 'edge-tts': 'edge-tts', font: '字幕字体',
     local_mt: '本地翻译', whisper_model: 'Whisper 模型',
-    llm: 'LLM', telegram: 'Telegram',
+    llm: 'LLM', telegram: 'Telegram', reddit_auth: 'Reddit 凭证',
   }
   const rows = [
     'ffmpeg', 'ffprobe', 'biliup', 'yt-dlp', 'edge-tts', 'font',
-    'local_mt', 'whisper_model', 'llm', 'telegram',
+    'local_mt', 'whisper_model', 'llm', 'telegram', 'reddit_auth',
   ]
   const ff = data?.ffmpeg as { status?: string; libass?: boolean; version?: string } | undefined
 
   return (
     <div className="mt-2 flex flex-col gap-2">
       <div className="flex flex-wrap items-center gap-1.5 text-xs">
         {rows.map((key) => {
           const d = (data?.[key] as { status?: string; path?: string } | undefined) ?? {}
           const ok = d.status === 'ok'
           return (
