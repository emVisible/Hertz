### Task 2: 代理旁路收进单一作者（7 处 → 1 处）+ 仓库级守卫

**Files:**
- Modify: `backend/infrastructure/net.py`（新增 `system_proxy()`，`client_kwargs()` 保持唯一决策点）
- Modify: `backend/ai/providers/openai_compat.py:57`、`backend/ai/providers/comfyui.py:31`、`backend/monoline/hf.py:230`、`backend/pipeline/producers/asr.py:347`（四处手写 `trust_env=`）
- Modify: `backend/pipeline/collectors/reddit.py:105-115`、`backend/pipeline/reddit_media.py:79-86`（两份独立 `getproxies()` 读取）
- Test: `tests/test_net_proxy_bypass.py`（扩展）、新建 `tests/test_proxy_authority.py`（守卫）

**Interfaces:**
- Consumes: 现有 `net.client_kwargs(url, **kwargs) -> dict`（对回环关 `trust_env`，其余默认跟随环境/系统代理）、`net.is_loopback_url(url) -> bool`
- Produces: `net.system_proxy() -> str | None`（系统/环境代理发现，唯一作者）；所有 httpx client 构造点改为 `httpx.AsyncClient(**client_kwargs(target, ...))`

- [ ] **Step 1: 写守卫（先红）——仓库里不许再有第二处代理决策**

新建 `tests/test_proxy_authority.py`：
```python
"""代理旁路只有一个作者（v0.33 收口）。

实测形状：同一件「本地直连、外部走系统代理」的事被写了 7 遍 ——
ai/providers/openai_compat.py、ai/providers/comfyui.py、monoline/hf.py、
pipeline/producers/asr.py 各自 `trust_env=False`，collectors/reddit.py 与
reddit_media.py 各有一份 `getproxies()` 读取，加上本片新增的
infrastructure/net.py。并发工作流还独立「修好」过一次同类 502，
说明不收敛就会继续长。
"""
from __future__ import annotations

import ast
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OWNER = Path("backend/infrastructure/net.py")


def _hits(needle: str) -> list[str]:
    out: list[str] = []
    for path in (ROOT / "backend").rglob("*.py"):
        if "__pycache__" in str(path):
            continue
        rel = path.relative_to(ROOT)
        if rel == OWNER:
            continue
        if needle in path.read_text(encoding="utf-8"):
            out.append(str(rel))
    return out


def test_no_hand_rolled_trust_env_outside_net() -> None:
    offenders = _hits("trust_env")
    assert not offenders, f"trust_env 又被自己判了一次: {sorted(offenders)}"


def test_no_second_proxy_discovery() -> None:
    offenders = _hits("getproxies")
    assert not offenders, f"代理发现出现第二个作者: {sorted(offenders)}"


def test_net_owner_actually_exists() -> None:
    """守卫不许是空转的：作者文件必须真在被要求的位置上。"""
    src = (ROOT / OWNER).read_text(encoding="utf-8")
    tree = ast.parse(src)
    names = {n.name for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)}
    assert {"client_kwargs", "is_loopback_url", "system_proxy"} <= names
```

- [ ] **Step 2: 跑守卫，确认它在红（且红的是那 7 处）**

Run: `uv run pytest tests/test_proxy_authority.py -q > /tmp/proxy_guard.log 2>&1; echo EXIT=$?`
Expected: 非 0；失败信息里列出 openai_compat / comfyui / monoline hf / asr / reddit / reddit_media（这正是收口清单）

- [ ] **Step 3: `net.py` 补上代理发现这一半权威**

在 `backend/infrastructure/net.py` 末尾追加：
```python
def system_proxy() -> str | None:
    """系统/环境代理 URL（唯一发现入口）。

    macOS 的代理设置不在环境变量里，`urllib.request.getproxies()` 会去读
    SystemConfiguration；Reddit 采集与签名直链解析此前各写了一份这段逻辑，
    于是「谁走代理」这件事有两个作者（D-205 同类形状）。
    """
    try:
        import urllib.request

        proxies = urllib.request.getproxies()
    except Exception:  # noqa: BLE001 — 探测失败按无代理处理，不让采集崩
        return None
    return proxies.get("https") or proxies.get("http") or None
```

- [ ] **Step 4: 四处 `trust_env=False` 改为按目标主机判断**

统一形态（以 `backend/ai/providers/openai_compat.py` 为例；comfyui / monoline hf / asr 的 xinference 客户端同法）：
```python
        from backend.infrastructure.net import client_kwargs

        self._client = httpx.AsyncClient(
            base_url=base_url,
            # 本地 Provider（Ollama/ComfyUI/xinference 常在 127.0.0.1）必须直连：
            # 代理到不了回环地址，Clash 在时只会回 502。判据在 infrastructure/net。
            **client_kwargs(base_url, timeout=..., follow_redirects=True),
        )
```
行为差异（有意为之，写进提交信息）：指向**非**回环主机的 Provider 现在会正常跟随系统代理，而不是被无条件关掉。

- [ ] **Step 5: 两份 `getproxies()` 改调 `system_proxy()`**

`backend/pipeline/collectors/reddit.py`：删掉本地 `_system_proxy()` 实现体，改为
```python
def _system_proxy() -> str | None:
    """系统代理发现已收进 infrastructure/net（唯一作者）——此处只留转发。"""
    from backend.infrastructure.net import system_proxy

    return system_proxy()
```
`backend/pipeline/reddit_media.py:79-86`：删掉内联的 try/`getproxies` 片段，改成
```python
    from backend.infrastructure.net import system_proxy

    proxy = system_proxy()
```

- [ ] **Step 6: 扩既有单测，钉住两种语义**

在 `tests/test_net_proxy_bypass.py` 追加：
```python
def test_system_proxy_returns_usable_url(monkeypatch) -> None:
    import urllib.request

    from backend.infrastructure.net import system_proxy

    monkeypatch.setattr(urllib.request, "getproxies", lambda: {"http": "http://127.0.0.1:7897"})
    assert system_proxy() == "http://127.0.0.1:7897"
    monkeypatch.setattr(urllib.request, "getproxies", lambda: {})
    assert system_proxy() is None


def test_remote_provider_still_follows_env_proxy() -> None:
    """本地直连不等于「所有 Provider 都不走代理」——远端主机必须照旧。"""
    assert client_kwargs("http://127.0.0.1:11434/v1")["trust_env"] is False
    assert client_kwargs("https://comfyui.example.com:8188")["trust_env"] is True
```

- [ ] **Step 7: 全量验证（守卫 + 受影响测试 + 真跑一次本地 Provider）**

```bash
uv run pytest tests/test_proxy_authority.py tests/test_net_proxy_bypass.py tests/test_ai_registry.py tests/test_ai_router.py -q > /tmp/proxy_all.log 2>&1; echo PROXY_EXIT=$?
uv run python -c "
import asyncio
from backend.ai.providers.openai_compat import OpenAICompatProvider
async def m():
    p = OpenAICompatProvider(api_key='', base_url='http://localhost:11434/v1', model='batiai/gemma4-e4b:q4')
    print('models:', await p.list_models()); await p.aclose()
asyncio.run(m())
" > /tmp/ollama_probe.log 2>&1; echo OLLAMA_EXIT=$?
```
Expected: 两个退出码都是 0，且 `OLLAMA_EXIT=0` 时能打出模型列表（本机 Ollama 在跑；没跑就把这条记为未实测，不要跳过记录）。

- [ ] **Step 8: 提交**

```bash
git add backend/infrastructure/net.py backend/ai backend/monoline/hf.py backend/pipeline tests/test_proxy_authority.py tests/test_net_proxy_bypass.py
git commit -F - <<'MSG'
refactor(net): 代理旁路收成单一作者——7 处各自实现改调 infrastructure/net

同一件「本地目标直连、外部目标走系统代理」被写了 7 遍：四处手写 trust_env=False
（AI Provider / monoline / xinference）、两份 getproxies() 读取（Reddit 采集与
签名直链），加上本片为回环 502 新建的 infrastructure/net。并发工作流已经独立
「修好」过一次同类问题，说明不收敛就还会再长。

统一后行为有一处有意变化：指向非回环主机的 Provider 不再被无条件关掉环境代理。
新增 tests/test_proxy_authority.py 作仓库级守卫（含「作者文件必须真有那三个函数」
的防空转断言），删掉任一处收口即红。
MSG
```

---

