# -*- mode: python ; coding: utf-8 -*-
# Hertz 后端固化（v0.21 P0 安装即用）：onedir 打包 backend/entrypoint.py。
# 构建命令见 scripts/build-backend.sh；产物 electron/backend-dist/hertz-backend/。

import os
from PyInstaller.utils.hooks import collect_all, collect_data_files, collect_submodules

# tkinter 与本次无关且体积可观；faster_whisper 曾在列内——那正是「打包版转写
# 永远不可用」的直接原因（v0.31 B1/B2 移出，见 D-200）。
blocklist = ["tkinter"]

# 本地引擎运行时：ctranslate2 与 faster_whisper **没有** contrib hook，且各自的
# 原生库/资源藏在非标准位置——ctranslate2 在隐藏目录 .dylibs/，faster_whisper 的
# VAD 在 assets/silero_vad_v6.onnx（漏它则 vad_filter=True 的首次转写即崩）。
# av 与 onnxruntime 有 hook，但一并走 collect_all 以保证 dylib 与数据同层落位。
_local_engines = ("faster_whisper", "ctranslate2", "av", "onnxruntime", "tokenizers", "huggingface_hub")

# Monoline 融合域 TTS 链（v1.1 打包验证实测）：
# - soundfile 的 libsndfile 藏在 _soundfile_data 包内（无 hook 必漏）；
# - misaki 自带 data/词典资源（无 hook 必漏，中文 G2P 直接崩）；
# - espeakng_loader 把 dylib + espeak-ng-data 放在包内（就地加载，无需下载）；
# - kokoro_onnx/cn2an/pypinyin 系纯 Python 但只被函数内懒导入，静态分析扫不到。
_monoline_engines = (
    "soundfile",
    "kokoro_onnx",
    "misaki",
    "espeakng_loader",
    "cn2an",
    "pypinyin",
    "pypinyin_dict",
    "phonemizer",
)

datas = [
    ("alembic.ini", "."),
    ("alembic", "alembic"),
    # Monoline 融合域运行期数据（PyInstaller 不自动收包数据，漏任一项即
    # compose/themes/icons/fonts 在固化包里 FileNotFound 崩）：
    # templates/**（28 kinds + base）/ tokens/**（4 套主题）/
    # data/icons.json / vendor/**（gsap/katex/17MB 中文字源）。
    ("backend/monoline/templates", "backend/monoline/templates"),
    ("backend/monoline/tokens", "backend/monoline/tokens"),
    ("backend/monoline/data", "backend/monoline/data"),
    ("backend/monoline/vendor", "backend/monoline/vendor"),
]
# jieba 词典 / certifi CA 束等运行期数据
for pkg in ("jieba", "certifi", "edge_tts"):
    datas += collect_data_files(pkg)

binaries = []
_engine_hidden: list[str] = []
for pkg in _local_engines:
    _d, _b, _h = collect_all(pkg)
    datas += _d
    binaries += _b
    _engine_hidden += _h

_monoline_hidden: list[str] = []
for pkg in _monoline_engines:
    _d, _b, _h = collect_all(pkg)
    datas += _d
    binaries += _b
    _monoline_hidden += _h

hiddenimports = (
    [
        # uvicorn 标准件按需动态导入，静态分析扫不到
        "uvicorn.logging",
        "uvicorn.loops",
        "uvicorn.loops.asyncio",
        "uvicorn.lifespan",
        "uvicorn.lifespan.on",
        "uvicorn.protocols.http",
        "uvicorn.protocols.http.auto",
        "uvicorn.protocols.http.h11_impl",
        "uvicorn.protocols.websockets",
        "uvicorn.protocols.websockets.auto",
        # 驱动/后端
        "sqlalchemy.dialects.postgresql.asyncpg",
        "anyio._backends._asyncio",
        "apscheduler.schedulers.asyncio",
        "apscheduler.triggers.cron",
        "alembic.migration",
        # alembic/env.py 是以**数据文件**形式随包的，它里面的 import 对 PyInstaller
        # 静态分析完全不可见（v0.32 S1 实测踩坑：env.py 新引 migration_guard 后，
        # 固化后端每次首启迁移都 ImportError 崩溃，而源码级 380 项测试全绿）。
        # 凡 env.py 顶层引用的自研模块，都必须在这里显式列出。
        "backend.infrastructure.migration_guard",
        # yt-dlp 提取器全量动态加载——必须整包收口
    ]
    + collect_submodules("yt_dlp")
    + _engine_hidden
    + _monoline_hidden
    + [
        # backend.monoline.tts 链只被函数内懒导入（provider 按 protocol 分发），
        # 静态分析扫不到——漏任一个则固化包里切到 Kokoro 即 ImportError
        # （v0.32 S1 env.py 教训同类）。
        "backend.monoline.tts_zh",
        "backend.monoline.voices",
        "backend.monoline.narration",
        "backend.monoline.llm_plan",
        "backend.ai.providers.kokoro",
    ]
)

a = Analysis(
    ["backend/entrypoint.py"],
    pathex=[os.path.dirname(SPEC)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=blocklist,
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="hertz-backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="hertz-backend",
)
