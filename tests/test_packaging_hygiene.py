"""依赖声明与打包配置的卫生守卫（v0.31 B1 / D-200）。

存在理由：faster-whisper 曾长期住在 `[project.optional-dependencies].asr` 里，
而 `ctranslate2` 连声明都没有（只是 faster-whisper 的传递依赖）。CI、`scripts/dev.sh`
与发布模拟脚本一律跑裸 `uv sync`，于是「零 API 的转写与翻译」在开发态和打包态
**同时**不可用，且没有任何自动检查能发现这件事（v0.31 spike 才暴露）。
"""

from __future__ import annotations

import ast
import importlib.util
import re
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend"


def _dep_names(raw: str) -> set[str]:
    data = tomllib.loads(raw)
    return {
        re.split(r"[<>=!~;\[\s]", str(d))[0].strip().lower()
        for d in data["project"].get("dependencies", [])
    }


def test_local_engine_runtimes_are_main_dependencies() -> None:
    """被代码直接 import 的运行时必须是主依赖，不能靠可选组或传递依赖活着。"""
    names = _dep_names((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    for pkg in ("faster-whisper", "ctranslate2", "sentencepiece"):
        assert pkg in names, f"{pkg} 不在主依赖里——本地引擎会静默不可用"


def test_asr_optional_group_stays_retired() -> None:
    """`asr` 可选组一旦复活，裸 uv sync 的环境又会悄悄失去转写能力。"""
    data = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    assert "asr" not in data["project"].get("optional-dependencies", {})


def test_no_stale_extra_asr_instructions() -> None:
    """代码里不得再出现 `uv sync --extra asr`——对 dmg 用户无意义且已失效。"""
    offenders = [
        str(p.relative_to(ROOT))
        for p in sorted(BACKEND.rglob("*.py"))
        if "--extra asr" in p.read_text(encoding="utf-8")
    ]
    assert not offenders, "仍在指导用户安装可选组: " + ", ".join(offenders)


def test_frozen_read_config_files_are_ascii_only() -> None:
    """固化进程会读的配置文件必须纯 ASCII。

    v0.32 S6 实测踩坑：给 alembic.ini 加了中文注释（本意是解释 path_separator），
    结果冻结后端首启即 `UnicodeDecodeError: 'ascii' codec can't decode byte 0xe6`
    ——configparser 在 PyInstaller 运行期按 ASCII 解这个文件，而 dev 态 Python 默认
    UTF-8，所以源码级测试全绿、只有产物会崩（正是 S5 产物门禁抓到的）。

    范围只含「冻结运行期真会被解析」的文件：pyproject.toml 等只在安装期被
    tomllib/uv 以 UTF-8 读取，纳入只会制造虚警（第一版就误纳过一次）。"""
    offenders = []
    for rel in ("alembic.ini",):
        raw = (ROOT / rel).read_bytes()
        try:
            raw.decode("ascii")
        except UnicodeDecodeError as exc:
            offenders.append(f"{rel}: {exc}")
    assert not offenders, "冻结运行期读取的配置文件含非 ASCII 内容: " + "; ".join(offenders)


def test_alembic_env_imports_are_reachable_or_declared() -> None:
    """alembic/env.py 以**数据文件**进包，它的 import 对 PyInstaller 不可见。

    v0.32 S1 实测踩坑：env.py 新引 migration_guard 而无人登记 → 冻结固化后端
    首启迁移即 ImportError 崩溃，而源码级 380 项测试全绿、`verify.sh` 也绿。
    规则：env.py 顶层引用的自研模块，要么从冻结入口可达（被运行时代码 import），
    要么在 hertz.spec 的 hiddenimports 里显式登记。"""
    import ast

    backend_root = ROOT / "backend"

    def local_imports(path: Path) -> set[str]:
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"))
        except (OSError, SyntaxError):
            return set()
        found: set[str] = set()
        for node in ast.walk(tree):
            mod = getattr(node, "module", None) or ""
            if isinstance(node, ast.ImportFrom) and mod.startswith("backend"):
                found.add(mod)
                found.update(f"{mod}.{a.name}" for a in node.names)
            elif isinstance(node, ast.Import):
                found.update(a.name for a in node.names)
        return found

    def module_source(dotted: str) -> Path | None:
        """模块 → 源文件。必须走 importlib 而不是 Path.exists()：
        macOS APFS 默认大小写不敏感，`backend/models/Base.py` 会被 exists()
        判为存在（真实文件是 base.py），把符号误认成子模块。"""
        try:
            spec = importlib.util.find_spec(dotted)
        except (ImportError, ValueError, ModuleNotFoundError):
            return None
        origin = getattr(spec, "origin", None) if spec else None
        if not origin or origin in {"frozen", "built-in"}:
            return None
        path = Path(origin)
        return path if path.exists() else None

    def is_real_module(dotted: str) -> bool:
        return module_source(dotted) is not None

    # 从冻结入口做静态 BFS：凡运行图够得到的自研模块，PyInstaller 自己能收集到
    queue: list[Path] = [backend_root / "entrypoint.py"]
    seen: set[str] = set()
    scanned: set[Path] = set()
    while queue:
        path = queue.pop()
        if path in scanned or not path.exists():
            continue
        scanned.add(path)
        for mod in local_imports(path):
            seen.add(mod)
            resolved = module_source(mod)
            if resolved:
                queue.append(resolved)

    spec_src = (ROOT / "hertz.spec").read_text(encoding="utf-8")
    env_src = (ROOT / "alembic" / "env.py").read_text(encoding="utf-8")
    unregistered = []
    for node in ast.walk(ast.parse(env_src)):
        if not isinstance(node, ast.ImportFrom) or not (node.module or "").startswith("backend"):
            continue
        for alias in node.names:
            dotted = f"{node.module}.{alias.name}"
            # 「from pkg import name」里 name 可能是子模块，也可能只是符号——
            # 只有真子模块才需单独收集（符号随父模块一起进包）
            requirement = dotted if is_real_module(dotted) else node.module
            if requirement in seen or requirement in spec_src:
                continue
            unregistered.append(requirement)
    assert not unregistered, (
        "alembic/env.py 引用的模块既不从冻结入口可达、也未登记 hiddenimports，"
        "固化后端首启会 ImportError: " + ", ".join(sorted(set(unregistered)))
    )


def test_migration_guard_is_declared_for_freeze() -> None:
    """S1 回归直钉：migration_guard 必须留在 spec 的登记清单里。"""
    spec_src = (ROOT / "hertz.spec").read_text(encoding="utf-8")
    assert "backend.infrastructure.migration_guard" in spec_src, (
        "alembic/env.py 依赖的守卫模块未登记——固化后端首启即崩（v0.32 S1 实测）"
    )


def test_local_engine_not_blocked_from_bundle() -> None:
    """hertz.spec 不得再把本地引擎放进 excludes。

    `faster_whisper` 曾长期列在 blocklist 里——它让「转写随包可用」这件事在
    源码、文档、测试三处都成立，只有产物里没有，且任何测试都碰不到。"""
    spec = (ROOT / "hertz.spec").read_text(encoding="utf-8")
    m = re.search(r"^blocklist\s*=\s*\[(.*?)\]", spec, re.M | re.S)
    assert m, "读不到 blocklist 定义"
    blocked = {s.strip().strip("\"'") for s in m.group(1).split(",") if s.strip()}
    for pkg in ("faster_whisper", "ctranslate2", "av", "onnxruntime"):
        assert pkg not in blocked, f"{pkg} 又被排除出固化包——打包版将静默失去该能力"


def test_frozen_entrypoint_declares_freeze_support() -> None:
    """冻结入口必须先 freeze_support()。

    v0.31 spike 实测：缺它时每次构造 WhisperModel 都会让冻结体自我重跑
    （45 秒内进程 1→7，累积观测到 138 个残留）——第一次转写就拖死用户机器，
    而非冻结的开发态完全看不出问题。"""
    src = (ROOT / "backend" / "entrypoint.py").read_text(encoding="utf-8")
    tree = ast.parse(src)
    main_fn = next(
        n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "main"
    )
    calls = [
        n for n in ast.walk(main_fn)
        if isinstance(n, ast.Call)
        and isinstance(n.func, ast.Attribute)
        and n.func.attr == "freeze_support"
    ]
    assert calls, "entrypoint.main() 缺 multiprocessing.freeze_support()"
    # 必须在使用任何子进程之前——即排在数据库/迁移调用之前
    first_call_line = min(c.lineno for c in calls)
    migrate_calls = [
        n.lineno for n in ast.walk(main_fn)
        if isinstance(n, ast.Call)
        and isinstance(n.func, ast.Name)
        and n.func.id in {"_ensure_database", "_migrate"}
    ]
    assert migrate_calls, "找不到启动步骤，守卫假设已变"
    assert first_call_line < min(migrate_calls), "freeze_support 必须最先执行"
