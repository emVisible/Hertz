"""设置页「改了要存得下去」的仓库级护栏（v0.32 S4.1）。

存在理由：v0.20 把 SettingsPage 拆成 sections 时，`save()` 里的字段表被删成
`overrides: {}` ——此后整整十几个版本，设置页每个输入框都是装饰品：改动只活在
内存里，点保存却 toast「已保存」。tsc、vitest、pytest 与人工冒烟全都看不见，
因为它「一切正常」的形式恰好是空载荷该有的形式。

所以这里不测某个字段，测的是这条链的三个断点：
① 分区里能编辑的 key 必须在主壳有草稿（没草稿 = 保存时被丢掉）；
② 草稿 key 必须在后端白名单里（不在 = 整个 PATCH 400，全部字段一起存不下）；
③ `save()` 不得再退回字面量空对象。
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SETTINGS_DIR = ROOT / "frontend/src/pages/settings"
BACKEND_CONFIG = ROOT / "backend/routers/config.py"


def _allowlist() -> set[str]:
    tree = ast.parse(BACKEND_CONFIG.read_text(encoding="utf-8"))
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id == "RUNTIME_ALLOWLIST":
                    return {
                        str(e.value)
                        for e in node.value.elts
                        if isinstance(e, ast.Constant)
                    }
    raise AssertionError("backend/routers/config.py 里找不到 RUNTIME_ALLOWLIST")


def _seed_keys() -> set[str]:
    """主壳 `setForm({...})` 里种下的草稿键。"""
    src = (SETTINGS_DIR / "SettingsPage.tsx").read_text(encoding="utf-8")
    start = src.index("setForm({")
    body = src[start:]
    end = body.index("\n    })")
    block = body[:end]
    return set(re.findall(r"^\s{6}([A-Za-z0-9_]+):", block, re.M))


def _edited_keys() -> set[str]:
    """分区里真正可编辑/可读取的键（`set('k', …)` 与 `form.k`）。"""
    out: set[str] = set()
    for path in sorted(SETTINGS_DIR.rglob("*.tsx")):
        if path.name == "SettingsPage.tsx":
            continue
        src = path.read_text(encoding="utf-8")
        out |= set(re.findall(r"set\(\s*'([A-Za-z0-9_]+)'", src))
        out |= set(re.findall(r"\bform\.([A-Za-z0-9_]+)", src))
    return out


def test_every_edited_key_has_a_draft_seed() -> None:
    seeds = _seed_keys()
    missing = sorted(_edited_keys() - seeds)
    assert not missing, (
        "这些设置项能被编辑却没进草稿，保存时会被整个丢掉（v0.20 那次的形状）: "
        + ", ".join(missing)
    )


def test_every_seed_is_runtime_writable() -> None:
    """草稿里的键必须都能写：PATCH 对未知键整体 400，一个漏白名单就全盘存不下。"""
    allow = _allowlist()
    unknown = sorted(_seed_keys() - allow)
    assert not unknown, (
        "SettingsPage 草稿含后端不接受的键，保存必然 400: " + ", ".join(unknown)
    )


def test_seed_is_not_trivially_small() -> None:
    """草稿键数量掉到 5 以下 = 主壳被掏空（v0.20 回归的直接形态）。"""
    assert len(_seed_keys()) >= 40, "设置页草稿疑似被删空——保存又是空载荷"


def test_save_sends_the_draft_diff_not_a_literal_empty_object() -> None:
    src = (SETTINGS_DIR / "SettingsPage.tsx").read_text(encoding="utf-8")
    assert not re.search(r"overrides:\s*\{\s*\}", src), (
        "save() 又回退成字面量空 overrides——设置页将只演出不落盘"
    )
    assert "buildOverrides(cfg, form)" in src, "save() 必须提交草稿与配置的差集"


def test_write_only_secret_fields_are_not_seeded_with_baseline() -> None:
    """只写不读的字段（后端滤掉）必须靠「空 = 不动」语义，不能拿 cfg 的值去种。

    反向保护：有人「顺手」把 cookie/secret 也写进 cfg 类型，等于假设后端会回吐
    明文——那是 §8.2 明令禁止的。
    """
    src = (SETTINGS_DIR / "SettingsPage.tsx").read_text(encoding="utf-8")
    for key in ("pipeline_reddit_cookie", "pipeline_reddit_client_secret"):
        assert re.search(rf"{key}: ''", src), (
            f"{key} 必须以空串为草稿（后端只写不读），不能从 cfg 取值"
        )


@pytest.mark.parametrize(
    "key", ["pipeline_hf_endpoint", "pipeline_whisper_model"]
)
def test_v032_model_settings_are_wired_end_to_end(key: str) -> None:
    """S4 新加的两项设置：后端有字段、白名单收得下、前端有种有编辑。"""
    assert key in _allowlist()
    assert key in _seed_keys()
    assert key in _edited_keys()
    assert key in (ROOT / "backend/config.py").read_text(encoding="utf-8")


# ---------- v0.34：设置页的「我的规范 / 固定计划」 ----------

NORMS_KEYS = ("creator_norms", "standing_plan")


@pytest.mark.parametrize("key", NORMS_KEYS)
def test_v034_norms_settings_are_wired_end_to_end(key: str) -> None:
    """用户要的是「自己能编辑的册子」，那就得走完整链：字段 → 白名单 → 草稿 → 分区编辑。"""
    assert key in _allowlist(), f"{key} 不在 RUNTIME_ALLOWLIST——PATCH 会整体 400，全页存不下"
    assert key in _seed_keys(), f"{key} 没进主壳草稿——保存时被整个丢掉（v0.20 的形状）"
    assert key in _edited_keys(), f"{key} 在分区里根本不可编辑，那这个字段就是死的"
    assert key in (ROOT / "backend/config.py").read_text(encoding="utf-8")


@pytest.mark.asyncio
async def test_norms_patch_round_trips_through_runtime_yaml(client) -> None:
    """真写 + 真读，内容带中文与换行。

    上面那条是源码级三段守卫，这条是端到端：只看「有没有接线」会放过
    「接了但存不下/读不回」——而这两段文字唯一的价值就是下次打开还在。
    """
    from backend.config import settings

    payload = {
        "creator_norms": "开头三行必须给冲突\n绝不写「家人们」",
        "standing_plan": "周一 AITA\n周三 关系类\n周五 复盘",
    }
    try:
        resp = await client.patch("/api/config", json={"overrides": payload})
        assert resp.status_code == 200, resp.text
        got = (await client.get("/api/config")).json()
        for key, value in payload.items():
            assert got.get(key) == value, f"{key} 存了但读不回来：{got.get(key)!r}"
    finally:
        for key in payload:
            vars(settings).pop(key, None)
        runtime = Path(settings.data_dir) / "runtime.yaml"
        if runtime.exists():
            runtime.unlink()


# ---------- 反向守卫：声明了却不给用户开关的字段（v0.37） ----------

def _allowlist_keys() -> set[str]:
    from backend.routers.config import RUNTIME_ALLOWLIST
    return set(RUNTIME_ALLOWLIST)


def _settings_fields() -> dict[str, object]:
    from backend.config import Settings
    return {n: f for n, f in Settings.model_fields.items()}


#: 故意不放进设置页的字段，以及**为什么**。
#:
#: 这份清单是「不作为」的证明：没有它，被排除的字段看起来和遗漏的字段一模一样。
#: 每条都要写清理由，否则下一个人会「顺手」把 secret_key 也放进去。
_NOT_EXPOSED = {
    "database_url": "连接凭据，且必须在建库前就位——运行期改它没有意义",
    "secret_key": "签名密钥，暴露到设置页等于开了后门",
    "backend_port": "启动期决定，改了必须重启并重启前端",
    "frontend_port": "启动期决定，同上",
    "ai_roles": "有独立的 PUT /api/ai/roles 端点与专门的 RolesManager 界面",
    "runtime_config_path": "派生属性，不是可调项",
}


@pytest.mark.parametrize("field", sorted(_NOT_EXPOSED))
def test_deliberately_excluded_fields_stay_excluded(field: str) -> None:
    """被排除的字段不得出现在 allowlist 里。

    一旦有人把 `secret_key` 之类加进 allowlist，`PATCH /api/config` 就能改掉它，
    而 GET 又会把它剥掉——于是用户改了却读不到，或者更糟：某条路径不经 GET
    直接用了新值。
    """
    assert field not in _allowlist_keys(), f"{field} 不该暴露给设置页"


def test_every_allowlisted_field_exists_in_settings() -> None:
    """allowlist 里不能有 Settings 里不存在的键——那种键写进 runtime.yaml
    之后永远读不到（`_EffectiveSettings` 只在属性缺失时回落），是个静默黑洞。"""
    fields = _settings_fields()
    ghosts = sorted(_allowlist_keys() - set(fields))
    assert not ghosts, f"allowlist 里有 Settings 不存在的键：{ghosts}"


def test_every_allowlisted_field_has_a_ui_seed() -> None:
    """能 PATCH 的字段就该在设置页有输入框，否则它仍然是半个假旋钮。

    v0.37 之前有 32 个字段属于这个状态：代码一直在读、注释写着给用户调，
    但既不在 allowlist 里所以设置页渲染不出来，用户只能改 .env。
    本条守卫让「以后再加一个新配置」不会重蹈覆辙。
    """
    src = (ROOT / "frontend/src/pages/settings/SettingsPage.tsx").read_text(encoding="utf-8")
    # 直接 PATCH、不经过主表单的字段（各自有专门的 UI 与即时生效语义）
    immediate = {
        "clipboard_monitor_enabled",  # GeneralSection 的开关卡片
        "backup_enabled",             # 同上
        "backup_keep",                 # 同上
        "ai_model_prices",             # AiSection 有自己的 UI
        "cost_currency",               # 同上
        "cost_usd_rate",               # 同上
        "cost_monthly_budget",         # 同上
        # v0.37：模型与 provider 已迁到 ai_providers 表，由 ProviderManager /
        # RolesManager 独立管理（见 ai/templates.py 模块注释：硬编码模型名会随
        # 平台改名而失效）。这三个 deepseek_* / comfyui / llm_api_key 是 v3.0
        # 迁移前留下的**种子字段**，运行时实际读的是 DB 里的 providers 行。
        # 它们留在 allowlist 只是历史包袱，不是可调项。
        "deepseek_api_key",
        "deepseek_base_url",
        "deepseek_model",
        "comfyui_base_url",
        "llm_api_key",
        # xinference 的 key 与 base_url 是同一台服务的凭据，UI 只给 base_url
        # 与 model_id；key 留作环境变量注入（与 deepseek_api_key 同类处理）。
        "xinference_api_key",
    }
    missing = sorted(
        k for k in _allowlist_keys()
        if k not in immediate and f"{k}:" not in src
    )
    assert not missing, f"这些字段可写却没有任何输入框：{missing}"
