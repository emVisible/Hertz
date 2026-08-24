"""本地翻译引擎（v0.22.x）：Opus-MT en→zh（ct2 格式）via ctranslate2。

- 模型按需下载（约 300MB，float16 ct2）到 data/models/opus-mt-en-zh；
  下载端点可经 pipeline_translate_hf_endpoint 切换镜像（国内网络场景）
- tokenizer 用 SentencePiece 直读 source/target.spm——不引入 transformers
  重依赖（sentencepiece 位于可选依赖组 translate；未安装时引擎不可用，
  调用方回落 api 三步法）
- 推理跑 CPU（int8），与 faster-whisper 共享 ctranslate2 运行时
"""

import asyncio
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

_MODEL_REPO = "gaudi/opus-mt-en-zh-ctranslate2"
# (文件名, 是否必需)——必需文件缺失视为模型不完整触发下载
_FILES: list[tuple[str, bool]] = [
    ("model.bin", True),
    ("source.spm", True),
    ("target.spm", True),
    ("vocab.json", True),
]

_translator_cache: dict = {}


def model_dir() -> Path:
    from backend.config import settings

    return Path(settings.data_dir) / "models" / "opus-mt-en-zh"


def _endpoint() -> str:
    from backend.config import settings

    endpoint = str(
        getattr(settings, "pipeline_translate_hf_endpoint", "") or ""
    ).strip().rstrip("/")
    return endpoint or "https://huggingface.co"


def deps_available() -> bool:
    """sentencepiece/ctranslate2 可导入（可选依赖组 translate 已安装）。"""
    try:
        import ctranslate2  # noqa: F401
        import sentencepiece  # noqa: F401

        return True
    except ImportError:
        return False


async def ensure_model(force: bool = False) -> Path | None:
    """确保 ct2 模型就绪；成功返回目录，失败返回 None（调用方回落 api）。"""
    import httpx

    d = model_dir()
    core_missing = [f for f, required in _FILES if required and not (d / f).exists()]
    if not core_missing and not force:
        return d
    try:
        d.mkdir(parents=True, exist_ok=True)
        base = f"{_endpoint()}/{_MODEL_REPO}/resolve/main"
        async with httpx.AsyncClient(timeout=120, follow_redirects=True) as client:
            for fname, required in _FILES:
                out = d / fname
                if out.exists():
                    continue
                resp = await client.get(f"{base}/{fname}")
                if resp.status_code == 404 and not required:
                    continue
                resp.raise_for_status()
                await asyncio.to_thread(out.write_bytes, resp.content)
                logger.info("downloaded %s (%d bytes)", fname, len(resp.content))
        still_missing = [f for f, req in _FILES if req and not (d / f).exists()]
        if still_missing:
            raise RuntimeError(f"download incomplete: {still_missing}")
        _translator_cache.clear()  # 目录内容变化 → 重建加载器
        logger.info("local MT model ready at %s", d)
        return d
    except Exception as exc:  # noqa: BLE001 — 下载失败由调用方回落 api
        logger.warning("local MT model download failed: %s", exc)
        return None


def _load():
    """懒加载 translator + spm 分词器（模块级缓存，目录变更自动重建）。"""
    import ctranslate2
    import sentencepiece as spm

    d = model_dir()
    cached_dir = _translator_cache.get("dir")
    if cached_dir != str(d):
        translator = ctranslate2.Translator(
            str(d), device="cpu", compute_type="int8",
        )
        src = spm.SentencePieceProcessor(model_file=str(d / "source.spm"))
        tgt = spm.SentencePieceProcessor(model_file=str(d / "target.spm"))
        _translator_cache.clear()
        _translator_cache.update({"dir": str(d), "t": translator, "src": src, "tgt": tgt})
    return (
        _translator_cache["t"],
        _translator_cache["src"],
        _translator_cache["tgt"],
    )


async def translate_batch_local(texts: list[str]) -> list[str]:
    """批量本地翻译（en→zh，单次 ct2 调用）。依赖缺失/模型未就绪 → RuntimeError。

    输出为原始机翻文本；字幕场景由调用方的既有清洗链处理。
    """
    texts = [t or "" for t in texts]
    if not any(t.strip() for t in texts):
        return [""] * len(texts)
    if not deps_available():
        raise RuntimeError(
            "本地翻译依赖未安装：uv sync --extra translate（sentencepiece）"
        )
    if await ensure_model() is None:
        raise RuntimeError("本地翻译模型未就绪且下载失败")
    translator, src_spm, tgt_spm = _load()

    def _run() -> list[str]:
        token_lists = [src_spm.encode(t[:2000], out_type=str) for t in texts]
        results = translator.translate_batch(token_lists, max_batch_size=32)
        return [tgt_spm.decode(r.hypotheses[0]).strip() for r in results]

    return await asyncio.to_thread(_run)


async def translate_local(text: str) -> str:
    """单条便捷封装。"""
    out = await translate_batch_local([text])
    return out[0] if out else ""
