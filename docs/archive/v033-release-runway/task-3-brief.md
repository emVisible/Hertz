### Task 3: Reddit 凭证可见性（能力矩阵 + 状态端点，遵循 D-190 四件套）

**Files:**
- Modify: `backend/infrastructure/deps.py`（新增 `_check_reddit_auth()` 并入 `check_dependencies()`）
- Modify: `backend/routers/pipeline_ops.py`（`GET /pipeline/reddit-auth/status`）
- Modify: `frontend/src/pages/settings/sections/settingsCards.tsx:111,116`（LABELS + 顺序表）
- Test: `tests/test_pipeline_governance.py` 追加，或新建 `tests/test_reddit_auth_card.py`

**Interfaces:**
- Consumes: `settings.pipeline_reddit_client_id` / `pipeline_reddit_client_secret`（均已在 `RUNTIME_ALLOWLIST`；secret 是 SECRET_FIELDS 只写不读）、`collectors.reddit.ensure_reddit_token() -> str | None`
- Produces: 能力矩阵条目 `reddit_auth = {"status": "ok"|"off", "detail": str}`；`GET /api/pipeline/reddit-auth/status` → `{"configured": bool, "token_ok": bool|None, "hint": str}`

- [ ] **Step 1: 写失败测试（矩阵条目 + 端点形状 + 四件套齐备）**

`tests/test_reddit_auth_card.py`：
```python
"""Reddit 凭证必须是「能看见的状态」，不是「有时能用有时不能」。

现状（实测）：`pipeline_reddit_client_id` 为空 → `ensure_reddit_token()` 返回 None
→ v0.3.7 的签名直链兜底从未启用，而界面上没有任何地方说这件事。用户只看到
「下载偶尔 403」。D-190 的四件套就是为这类静默降级立的规矩。
"""
from __future__ import annotations

import pytest

from backend.config import settings
from backend.infrastructure import deps


@pytest.mark.asyncio
async def test_reddit_auth_card_off_when_unconfigured(monkeypatch) -> None:
    monkeypatch.setattr(settings, "pipeline_reddit_client_id", "")
    monkeypatch.setattr(settings, "pipeline_reddit_client_secret", "")
    card = deps._check_reddit_auth()
    assert card["status"] == "off"
    assert "设置" in card["detail"]  # 必须给出路，不能只说没配


@pytest.mark.asyncio
async def test_reddit_auth_card_ok_when_configured(monkeypatch) -> None:
    monkeypatch.setattr(settings, "pipeline_reddit_client_id", "cid")
    monkeypatch.setattr(settings, "pipeline_reddit_client_secret", "sec")
    assert deps._check_reddit_auth()["status"] == "ok"


@pytest.mark.asyncio
async def test_card_registered_everywhere_it_must_be(client) -> None:
    """D-190 四件套：矩阵条目 + 显示名 + 不阻断预检（匿名通道存在，故不映射）。"""
    body = (await client.get("/api/deps/check")).json() if False else None  # 占位禁用
    deps_dict = await deps.check_dependencies()
    assert "reddit_auth" in deps_dict
    from pathlib import Path
    labels = (Path(__file__).resolve().parents[1] / "frontend/src/pages/settings/sections/settingsCards.tsx").read_text(encoding="utf-8")
    assert "reddit_auth" in labels, "能力矩阵有条目但界面无显示名 = 用户永远看不到"
```
（提交前删掉那行 `body = ...` 占位——写在这里只是为了提醒：端点断言放到下一个 step 里真跑。）

- [ ] **Step 2: 跑它，确认失败**

Run: `uv run pytest tests/test_reddit_auth_card.py -q > /tmp/auth1.log 2>&1; echo EXIT=$?`
Expected: `AttributeError: module 'backend.infrastructure.deps' has no attribute '_check_reddit_auth'`

- [ ] **Step 3: 实现矩阵条目**

`backend/infrastructure/deps.py` 内新增，并在 `check_dependencies()` 字典里加 `"reddit_auth": _check_reddit_auth(),`：
```python
def _check_reddit_auth() -> dict:
    """Reddit OAuth 凭证（决定 v.redd.it 被 403 时能否走签名直链）。

    为什么单列一条：`ensure_reddit_token()` 未配置时直接返回 None，签名直链兜底
    「从未生效」这件事在界面上完全不可见——用户体感只是「下载偶尔失败」，
    正是 D-190 要消灭的静默形状。它是可选能力（匿名通道可用），故只报不阻断。
    """
    configured = bool(
        str(getattr(settings, "pipeline_reddit_client_id", "") or "").strip()
        and str(getattr(settings, "pipeline_reddit_client_secret", "") or "").strip()
    )
    if configured:
        return {"status": "ok", "detail": "签名直链兜底已启用"}
    return {
        "status": "off",
        "detail": "未配置凭证：v.redd.it 被 CDN 403 时无签名直链可用",
        "install_hint": "设置 → 流水线 → Reddit 采集（建 script 应用后填 client id/secret）",
    }
```

- [ ] **Step 4: 状态端点（凭证填完能自己验，不用去猜）**

`backend/routers/pipeline_ops.py` 追加（放在 `/integrity` 旁边）：
```python
@router.get("/reddit-auth/status")
async def reddit_auth_status(probe: bool = False) -> dict:
    """Reddit 凭证状态：是否已配 + 可选的 token 真取（probe=true 才联网）。

    默认不联网：设置页每次渲染都打 Reddit 会被限流；用户填完凭证手动 probe。
    """
    from backend.config import settings as _s
    from backend.pipeline.collectors.reddit import ensure_reddit_token

    configured = bool(
        str(_s.pipeline_reddit_client_id or "").strip()
        and str(_s.pipeline_reddit_client_secret or "").strip()
    )
    token_ok: bool | None = None
    if configured and probe:
        token_ok = bool(await ensure_reddit_token())
    return {
        "configured": configured,
        "token_ok": token_ok,
        "hint": "" if configured else "在 reddit.com/prefs/apps 建 script 应用后填进设置",
    }
```

- [ ] **Step 5: 界面显示名 + 顺序**

`frontend/src/pages/settings/sections/settingsCards.tsx`：`LABELS` 加
`reddit_auth: 'Reddit 凭证',`，并把 `'reddit_auth'` 加进条目顺序数组（放在 `'whisper_model'` 之后）。

- [ ] **Step 6: 修掉 Step 1 里那行占位，补端点断言**

`tests/test_reddit_auth_card.py` 里删掉 `body = ...` 那行，并追加：
```python
@pytest.mark.asyncio
async def test_status_endpoint(client, monkeypatch) -> None:
    monkeypatch.setattr(settings, "pipeline_reddit_client_id", "")
    monkeypatch.setattr(settings, "pipeline_reddit_client_secret", "")
    r = await client.get("/api/pipeline/reddit-auth/status")
    assert r.status_code == 200
    assert r.json() == {"configured": False, "token_ok": None,
                        "hint": "在 reddit.com/prefs/apps 建 script 应用后填进设置"}
```
同步 `docs/API_INVENTORY.md`：`uv run python scripts/api_inventory.py`（它是唯一作者，别手写）。

- [ ] **Step 7: 全量门禁 + 提交**

```bash
uv run ruff check backend tests > /tmp/r3.log 2>&1; echo RUFF_EXIT=$?
uv run pytest tests/test_reddit_auth_card.py tests/test_pipeline_governance.py -q > /tmp/r3b.log 2>&1; echo PYTEST_EXIT=$?
cd frontend && npx tsc --noEmit > /tmp/r3c.log 2>&1; echo TSC_EXIT=$?
```
Expected: 三个都 0。

```bash
git add backend/infrastructure/deps.py backend/routers/pipeline_ops.py frontend/src/pages/settings/sections/settingsCards.tsx docs/API_INVENTORY.md tests/test_reddit_auth_card.py
git commit -F - <<'MSG'
feat(reddit): 凭证状态可见——能力矩阵条目 + probe 端点

未配 client id/secret 时 ensure_reddit_token 直接返回 None，v0.3.7 的签名直链
兜底从未启用，而界面上没有任何地方说这件事：用户体感只是「下载偶尔 403」。
按 D-190 四件套补一条矩阵条目（off/ok + 出路文案）与显示名，并加
GET /api/pipeline/reddit-auth/status（probe=true 才真取 token，避免设置页渲染
就被限流）。可选能力，不阻断预检：匿名通道本就能用。
MSG
```

---

