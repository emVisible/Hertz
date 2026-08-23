# -*- mode: python ; coding: utf-8 -*-
# Hertz 后端固化（v0.21 P0 安装即用）：onedir 打包 backend/entrypoint.py。
# 构建命令见 scripts/build-backend.sh；产物 electron/backend-dist/hertz-backend/。

import os
from PyInstaller.utils.hooks import collect_data_files, collect_submodules

blocklist = ["tkinter", "faster_whisper"]

datas = [
    ("alembic.ini", "."),
    ("alembic", "alembic"),
]
# jieba 词典 / certifi CA 束等运行期数据
for pkg in ("jieba", "certifi", "edge_tts"):
    datas += collect_data_files(pkg)

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
        # yt-dlp 提取器全量动态加载——必须整包收口
    ]
    + collect_submodules("yt_dlp")
)

a = Analysis(
    ["backend/entrypoint.py"],
    pathex=[os.path.dirname(SPEC)],
    binaries=[],
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
