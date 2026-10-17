"""runtime.yaml 的「陈旧默认值钉子」必须失效（v0.36 事故）。

事故形状：`data/runtime.yaml` 里的值**压过**类默认值（`_EffectiveSettings`
先读 runtime.yaml）。设置页保存的是表单全量快照，所以用户没碰过的字段也会被
写进去。v0.36 把 `log_dir` 默认值从 `logs` 改成 `data/logs`——本机文件里那行
`log_dir: logs`（10-12 存设置页时留下的旧默认回声）让新默认值**从未生效**，
应用一直往 `logs/hertz.log` 写，而且没有任何报错。

这类 bug 天然隐形：改默认值的人看到的是「我改了」，跑测试看到的是「绿的」，
只有真机日志路径能揭发它。所以这里守的是**语义**而不是某一行的值。

变异对照（改任一条，对应测试必须变红）：
- 把 `_LEGACY_RUNTIME_VALUES["log_dir"]` 改回空元组 → 读时不再丢弃 → 红
- 把 `_prune_redundant_path_defaults` 改成 `return dict(data)` → 写时不再摘 → 红
- 把 `_prune_redundant_path_defaults` 改成无差别 `out.clear()` → 第五条红
"""

from __future__ import annotations

from pathlib import Path

import pytest

from backend.config import Settings, runtime_config, settings


def _runtime_path() -> Path:
    return Path(settings.data_dir) / "runtime.yaml"


@pytest.fixture
def runtime_file():
    """给每个用例一份干净的 runtime.yaml，测完还原（连同 mtime 缓存）。"""
    path = _runtime_path()
    backup = path.read_text(encoding="utf-8") if path.exists() else None
    if path.exists():
        path.unlink()
    runtime_config._cached = None
    runtime_config._cached_mtime = None
    try:
        yield path
    finally:
        if path.exists():
            path.unlink()
        if backup is not None:
            path.write_text(backup, encoding="utf-8")
        runtime_config._cached = None
        runtime_config._cached_mtime = None


def _write(path: Path, body: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")


def _default(field: str) -> Path:
    return Settings.model_fields[field].default


# ---------- 读时：被取代的旧默认值不再遮住新默认值 ----------


def test_legacy_pin_is_dropped_in_isolation(tmp_path) -> None:
    """最硬的一条：与 env / cwd / 仓库状态全都无关的纯逻辑守卫。

    conftest 注入 `HERTZ_LOG_DIR`，所以测试环境里「生效基线」本来就不是类默认值。
    读时丢弃这件事必须能脱离这些变量单独成立——否则它在 CI 上是绿的、在真机上
    仍然是错的。
    """
    from backend.config import RuntimeConfig

    path = tmp_path / "runtime.yaml"
    path.write_text("log_dir: logs\n", encoding="utf-8")

    assert "log_dir" not in RuntimeConfig(path=path).load()


def test_legacy_log_dir_pin_does_not_shadow_the_new_default(runtime_file) -> None:
    """本机真实形态：`log_dir: logs` 留在文件里，生效值必须一步不差。"""
    baseline = settings.log_dir
    _write(runtime_file, "log_dir: logs\n")

    assert settings.log_dir == baseline, (
        f"runtime.yaml 里的旧默认回声把 log_dir 从 {baseline} 改成了 {settings.log_dir}"
        "——v0.36 的默认值变更在这台机器上从未生效过"
    )
    assert "log_dir" not in runtime_config.load()


def test_legacy_pin_is_dropped_without_touching_the_user_file(runtime_file) -> None:
    """丢弃只发生在读侧：用户资产不被我们改写。"""
    _write(runtime_file, "log_dir: logs\n")

    runtime_config.load()

    assert "log_dir" in runtime_file.read_text(encoding="utf-8"), (
        "读时清理不得回写 runtime.yaml——那是用户的文件"
    )


def test_deliberate_custom_log_dir_still_wins(runtime_file) -> None:
    """清洗只能打掉「当年那个默认」，不能吃掉用户真的选过的目录。"""
    _write(runtime_file, "log_dir: /var/log/hertz\n")

    assert Path(settings.log_dir) == Path("/var/log/hertz")
    assert runtime_config.load()["log_dir"] == "/var/log/hertz"


def test_prune_recognises_the_default_in_every_spelling() -> None:
    """同一目录的相对/带 ./ /绝对三种写法，都算「就是默认值」。"""
    from backend.routers.config import _prune_redundant_path_defaults

    default = str(_default("log_dir"))
    for spelling in (default, f"./{default}", str(Path(default).resolve())):
        assert _prune_redundant_path_defaults({"log_dir": spelling}) == {}, (
            f"{spelling!r} 指向的就是默认值，却没被摘掉——换个写法就能绕过清洗"
        )


# ---------- 写时：默认值不再被存成覆盖 ----------


@pytest.mark.asyncio
async def test_patch_storing_the_default_value_is_not_persisted(client, runtime_file) -> None:
    """存下「等于默认值」的值 = 给新默认值上了一道永久封印。"""
    baseline = settings.log_dir
    payload = {"overrides": {"log_dir": str(_default("log_dir"))}}
    resp = await client.patch("/api/config", json=payload)
    assert resp.status_code == 200, resp.text

    assert "log_dir" not in runtime_config.load(), "等于默认值的路径不该进 runtime.yaml"
    assert settings.log_dir == baseline


@pytest.mark.asyncio
async def test_patch_custom_log_dir_round_trips(client, runtime_file) -> None:
    """真覆盖必须存得下、读得回来（清洗不能把手伸到有效配置上）。"""
    resp = await client.patch("/api/config", json={"overrides": {"log_dir": "custom-logs"}})
    assert resp.status_code == 200, resp.text

    assert Path(settings.log_dir) == Path("custom-logs")
    assert runtime_config.load()["log_dir"] == "custom-logs"


@pytest.mark.asyncio
async def test_explicit_assets_root_pin_survives_pruning(client, runtime_file) -> None:
    """`assets_root` 默认是 None，所以 `assets_root: data` 是**显式选择**，不是回声。

    docs.py / library.py 直接读 `runtime_config.load()["assets_root"]`，一旦被误摘，
    素材浏览根就静默变成另一棵树。
    """
    resp = await client.patch("/api/config", json={"overrides": {"assets_root": "data"}})
    assert resp.status_code == 200, resp.text

    assert runtime_config.load().get("assets_root") == "data"


@pytest.mark.asyncio
async def test_prune_does_not_touch_scalars(client, runtime_file) -> None:
    """剪枝只限路径字段：标量在 yaml/JSON/字符串之间类型不定，比「相同」不可靠。"""
    default_score = Settings.model_fields["pipeline_min_score"].default
    resp = await client.patch(
        "/api/config", json={"overrides": {"pipeline_min_score": default_score}}
    )
    assert resp.status_code == 200, resp.text

    assert "pipeline_min_score" in runtime_config.load()


# ---------- 反向守卫：别把清洗做成「无差别清空」 ----------


def test_prune_is_not_a_blanket_wipe() -> None:
    """清洗必须逐字段判同——否则一次保存就把用户所有路径覆盖抹掉。"""
    from backend.routers.config import _prune_redundant_path_defaults

    kept = _prune_redundant_path_defaults(
        {"log_dir": "data/logs", "data_dir": "elsewhere", "pipeline_min_score": 6}
    )

    assert kept == {"data_dir": "elsewhere", "pipeline_min_score": 6}


def test_every_proxy_path_field_is_either_path_defaulted_or_none() -> None:
    """新增路径字段时，「逐字相同」必须仍然可判定。

    `_PATH_DEFAULT_FIELDS` 只收默认为 Path 的字段；漏掉一个新字段不会报错，
    只会让它重新变成可以自封默认值的形状——所以在字段清单这一层设卡。
    """
    from backend.config import _EffectiveSettings
    from backend.routers.config import _PATH_DEFAULT_FIELDS

    for field in _EffectiveSettings._PATH_FIELDS:
        default = Settings.model_fields[field].default
        assert field in _PATH_DEFAULT_FIELDS or default is None, (
            f"{field} 是代理层的路径字段但默认值是 {default!r}——"
            "要么它是 None（语义不同，另找办法），要么该进 _PATH_DEFAULT_FIELDS"
        )
