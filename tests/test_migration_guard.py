"""alembic autogenerate 数据保护闸测试（v0.32 S1）。

纯逻辑测试——不连库、不跑迁移：闸的价值正是在「生成迁移文件」那一刻拦住，
所以可以完全脱离数据库验证。
"""

from __future__ import annotations

from types import SimpleNamespace

from alembic.operations import ops as alembic_ops

from backend.infrastructure import migration_guard as mg

_BENIGN_A = object()  # 代表任何非删表 op（alembic 的 op 类名随版本变化，不与其绑死）
_BENIGN_B = object()


def _sample_ops() -> list:
    """一份混合 ops：一个删表（危险）+ 两个良性项。"""
    return [alembic_ops.DropTableOp("messages"), _BENIGN_A, _BENIGN_B]


def test_strip_removes_only_drop_table() -> None:
    ops_list = _sample_ops()
    removed = mg.strip_destructive_ops(ops_list, allow_drop=False)
    assert removed == ["messages"]
    assert not any(isinstance(o, alembic_ops.DropTableOp) for o in ops_list)
    # 良性操作必须原样留下且保持身份——闸只挡不可逆项，不做顺手瘦身
    assert ops_list == [_BENIGN_A, _BENIGN_B]


def test_explicit_allow_keeps_drop_table() -> None:
    ops_list = _sample_ops()
    snapshot = list(ops_list)
    assert mg.strip_destructive_ops(ops_list, allow_drop=True) == []
    assert ops_list == snapshot  # 显式放行时列表一字不动


def test_env_var_is_the_only_bypass(monkeypatch) -> None:
    monkeypatch.delenv(mg.ALLOW_DROP_ENV, raising=False)
    assert mg.drop_allowed() is False
    monkeypatch.setenv(mg.ALLOW_DROP_ENV, "1")
    assert mg.drop_allowed() is True
    # 开关生效时删表建议保留
    ops_list = _sample_ops()
    mg.strip_destructive_ops(ops_list)
    assert any(isinstance(o, alembic_ops.DropTableOp) for o in ops_list)
    # 非 "1" 的取值不算开（避免 "true"/"yes" 之类的误判语义分歧）
    monkeypatch.setenv(mg.ALLOW_DROP_ENV, "0")
    assert mg.drop_allowed() is False


def test_process_revision_directives_handles_real_alembic_shape() -> None:
    """用真实 `MigrationScript`/`UpgradeOps` 对象，不用自造形状。

    第一版实现按 `directives[0].ops` 取值——单测当时也用了自造的
    `SimpleNamespace(ops=...)`，于是测试全绿而 `alembic check` 直接
    AttributeError 崩掉。契约必须由被集成方的真实类型来钉。"""
    upgrade_ops = alembic_ops.UpgradeOps(ops=_sample_ops())
    downgrade_ops = alembic_ops.DowngradeOps(ops=[])
    script = alembic_ops.MigrationScript(
        "rev_test", upgrade_ops=upgrade_ops, downgrade_ops=downgrade_ops
    )
    mg.process_revision_directives(object(), object(), [script])
    assert not any(
        isinstance(o, alembic_ops.DropTableOp) for o in script.upgrade_ops.ops
    )
    assert script.downgrade_ops.ops == []  # 不碰另一侧


def test_process_revision_directives_tolerates_unknown_shape() -> None:
    """看不懂 directive 就跳过——闸本身不得成为迁移工具的故障源。"""
    mg.process_revision_directives(object(), object(), [object(), None, SimpleNamespace()])


def test_include_object_skips_legacy_unowned_tables() -> None:
    for table in ("messages", "conversations"):
        assert mg.include_object(None, table, "table", reflected=True, compare_to=None) is False
    # 模型侧有定义的表（compare_to 不为空）不受影响
    assert mg.include_object(None, "items", "table", reflected=True, compare_to=object()) is True
    # 新库上的列/索引对象照常比对
    assert mg.include_object(None, "archived", "column", reflected=True, compare_to=None) is True


def test_include_object_honors_the_same_bypass(monkeypatch) -> None:
    """两层闸必须认同一个开关。

    踩过的坑：include_object 无条件跳过 → `ALLOW_DROP_ENV` 对这两张表是假话，
    文档写着「设 =1 再生成」而设了也无效（实测 remove_table 一直为 0）。"""
    monkeypatch.delenv(mg.ALLOW_DROP_ENV, raising=False)
    assert mg.include_object(None, "messages", "table", reflected=True, compare_to=None) is False
    monkeypatch.setenv(mg.ALLOW_DROP_ENV, "1")
    assert mg.include_object(None, "messages", "table", reflected=True, compare_to=None) is True


def test_legacy_list_covers_what_always_reports_drift() -> None:
    """黑名单不得随意缩水：这两张表当前每次 `alembic check` 都会报 remove_table。

    真值来源是实测，不是记忆——故这里断言常量内容而非行为。"""
    assert mg.LEGACY_UNOWNED_TABLES == frozenset({"messages", "conversations"})


def test_env_wires_the_guard() -> None:
    """`alembic/env.py` 必须把闸接进两处 context.configure。

    接线本身在离线/在线两条路径上，任何一处漏接都等于没装。"""
    from pathlib import Path

    src = (Path(__file__).resolve().parent.parent / "alembic" / "env.py").read_text(
        encoding="utf-8"
    )
    assert src.count("process_revision_directives=migration_guard.process_revision_directives") == 2
    assert src.count("include_object=migration_guard.include_object") == 2
