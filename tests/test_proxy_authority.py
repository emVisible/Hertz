"""代理旁路只有一个作者（v0.33 收口）。

实测形状：同一件「本地直连、外部走系统代理」的事被写了 8 遍——
ai/providers/openai_compat.py、ai/providers/comfyui.py、monoline/hf.py、
pipeline/producers/asr.py 各自手写关环境代理，collectors/reddit.py、
reddit_media.py 与 infrastructure/hf.py 各有一份系统代理读取，加上本片为
回环 502 新建的 infrastructure/net.py。并发工作流还独立「修好」过一次同类
502，说明不收敛就会继续长。

守卫两个方向都要有：只禁旧形状（下面前两条）挡不住「把收口删掉、退回 httpx
默认」这种回退——它不含被禁的字面量，于是回环 502 原地复活。最后一条是正向棘轮。
"""
from __future__ import annotations

import ast
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OWNER = Path("backend/infrastructure/net.py")

# 收口清单（含收口前就已调用权威的两位消费者）。守卫是**正向**的：这些点必须
# 实际引用作者的 API，否则「删掉收口 + 什么都不传」也能过两条禁令。
CONVERGED = (
    "backend/ai/providers/openai_compat.py",
    "backend/ai/providers/comfyui.py",
    "backend/monoline/hf.py",
    "backend/pipeline/producers/asr.py",
    "backend/pipeline/collectors/reddit.py",
    "backend/pipeline/reddit_media.py",
    "backend/infrastructure/hf.py",
    "backend/pipeline/download.py",
    "backend/download/engine.py",
)
OWNER_API = ("client_kwargs", "system_prox")  # 后者同时覆盖 system_proxy 与 system_proxies


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


def test_converged_sites_still_call_the_owner() -> None:
    """正向棘轮：每个收口点都必须还在调作者的 API。

    删掉一处 `**client_kwargs(...)`（连旁路判断一起消失）不会命中前两条禁令——
    字面量没了就是「干净」，但那台 Clash 又会把本地请求回成 502。所以这里认的是
    引用本身，收口被回退即红。
    """
    missing = [
        rel
        for rel in CONVERGED
        if not any(needle in (ROOT / rel).read_text(encoding="utf-8") for needle in OWNER_API)
    ]
    assert not missing, f"这些收口点不再调用唯一作者（收口被回退？）: {missing}"

