"""代理旁路只有一个作者（v0.33 收口）。

实测形状：同一件「本地直连、外部走系统代理」的事被写了 8 遍——
ai/providers/openai_compat.py、ai/providers/comfyui.py、monoline/hf.py、
pipeline/producers/asr.py 各自手写关环境代理，collectors/reddit.py、
reddit_media.py 与 infrastructure/hf.py 各有一份系统代理读取，加上本片为
回环 502 新建的 infrastructure/net.py。并发工作流还独立「修好」过一次同类
502，说明不收敛就会继续长。
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
    assert {"client_kwargs", "is_loopback_url", "system_proxy", "system_proxies"} <= names
