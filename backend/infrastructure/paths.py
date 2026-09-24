"""本地模型的落位路径（v0.32 S4 单一真相源）。

为什么在 infrastructure：`deps.py` 的能力矩阵与 pipeline 侧的引擎都要探同一个
目录。此前 whisper 走 `~/.cache/huggingface`（HF 默认），而 `HERTZ_USER_DATA` /
`HERTZ_DATA_DIR` 隔离的存在理由正是「不碰 `$HOME`」——两处各说各话，探针在
打包版里永远看不到应用自己下载的模型。

依赖方向：infra 不 import pipeline；pipeline 与 routers 反向 import 本模块。
"""

from __future__ import annotations

from pathlib import Path

WHISPER_REPO_PREFIX = "faster-whisper"
#: faster-whisper（CT2 格式）模型文件与「是否必需」标记——下载清单与就绪探测同一份。
#: 必需集按 faster-whisper 1.2.1 的加载路径核过：`ctranslate2.models.Whisper(dir)` 要 model.bin +
#: config.json，tokenizer 要 tokenizer.json——**缺 tokenizer.json 时它会
#: `tokenizers.Tokenizer.from_pretrained("openai/whisper-tiny")` 联网兜底**，
#: 离线机器上表现为「模型明明下好了却仍失败」，故 tokenizer.json 算必需。
#: vocabulary.txt（老 conversion 才有）与 preprocessor_config.json（只有部分 repo
#: 有）按可选处理，404 不阻断。
WHISPER_FILES: tuple[tuple[str, bool], ...] = (
    ("model.bin", True),
    ("config.json", True),
    ("tokenizer.json", True),
    ("vocabulary.txt", False),
    ("preprocessor_config.json", False),
)
WHISPER_CORE_FILES = tuple(f for f, required in WHISPER_FILES if required)
#: Opus-MT（ct2）模型文件与「是否必需」标记——下载清单与就绪探测共用同一份，
#: 否则「下哪些文件」和「缺哪些算没就绪」会长成两处、各自漂移
LOCAL_MT_FILES: tuple[tuple[str, bool], ...] = (
    ("model.bin", True),
    ("source.spm", True),
    ("target.spm", True),
    ("vocab.json", True),
)
LOCAL_MT_CORE_FILES = tuple(f for f, required in LOCAL_MT_FILES if required)


def _data_dir() -> Path:
    from backend.config import settings

    return Path(settings.data_dir)


def models_dir() -> Path:
    return _data_dir() / "models"


def local_mt_dir() -> Path:
    """Opus-MT en→zh（ct2）目录（原 `translate_engine.model_dir()` 的约定上移）。"""
    return models_dir() / "opus-mt-en-zh"


def whisper_model_dir(name: str) -> Path:
    """faster-whisper 模型目录：`data_dir/models/whisper/faster-whisper-<name>`。

    这是一份**扁平的模型目录**，不是 HF 缓存树——下载端把文件直写到这里，加载时
    把同一个路径交给 `WhisperModel(str(dir))`（faster-whisper 见到已存在的目录就
    直接 `ctranslate2` 加载，完全不碰网络）。用 HF 缓存布局（`download_root=`）
    会把模型放回 `$HOME`，正是 S4 要消掉的那个双真相源。"""
    return models_dir() / "whisper" / f"{WHISPER_REPO_PREFIX}-{(name or '').strip()}"


def local_mt_ready() -> bool:
    d = local_mt_dir()
    return all((d / f).exists() for f in LOCAL_MT_CORE_FILES)


def whisper_model_ready(name: str) -> bool:
    d = whisper_model_dir(name)
    return bool((name or "").strip()) and all((d / f).exists() for f in WHISPER_CORE_FILES)
