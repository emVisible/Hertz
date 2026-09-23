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
import re
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


_MIRROR_ENDPOINT = "https://hf-mirror.com"
_download_alerted = False


def _candidate_endpoints(configured: str | None = None) -> list[str]:
    """下载端点候选序：用户配置优先 → 官方 → 镜像（去重）。

    抽为纯函数便于单测。
    """
    from backend.config import settings

    cfg = (
        configured
        if configured is not None
        else str(getattr(settings, "pipeline_translate_hf_endpoint", "") or "")
    ).strip().rstrip("/")
    out: list[str] = []
    for ep in (cfg, "https://huggingface.co", _MIRROR_ENDPOINT):
        if ep and ep not in out:
            out.append(ep)
    return out


def _alert(text: str) -> None:
    """告警（best-effort，进程内单次去重由调用方控制）。"""
    import asyncio

    from backend.integrations.telegram_bot import push_alert

    asyncio.ensure_future(push_alert(text))


def deps_available() -> bool:
    """sentencepiece/ctranslate2 可导入（可选依赖组 translate 已安装）。"""
    try:
        import ctranslate2  # noqa: F401
        import sentencepiece  # noqa: F401

        return True
    except ImportError:
        return False


async def ensure_model(force: bool = False) -> Path | None:
    """确保 ct2 模型就绪；多端点依序尝试（配置端点→官方→镜像）。

    全部失败：记录各端点错误原因 + Telegram 单次告警（进程生命周期去重，
    成功后复位），返回 None 由调用方回落 api/原文。
    """
    global _download_alerted
    d = model_dir()
    core_missing = [f for f, required in _FILES if required and not (d / f).exists()]
    if not core_missing and not force:
        return d
    try:
        d.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        logger.warning("local MT model dir create failed: %s", exc)
        return None

    errors: list[str] = []
    import httpx

    async with httpx.AsyncClient(timeout=120, follow_redirects=True) as client:
        for endpoint in _candidate_endpoints():
            try:
                base = f"{endpoint}/{_MODEL_REPO}/resolve/main"
                for fname, required in _FILES:
                    out = d / fname
                    if out.exists():
                        continue
                    resp = await client.get(f"{base}/{fname}")
                    if resp.status_code == 404 and not required:
                        continue
                    resp.raise_for_status()
                    await asyncio.to_thread(out.write_bytes, resp.content)
                    logger.info("downloaded %s from %s (%d bytes)",
                                fname, endpoint, len(resp.content))
                still_missing = [
                    f for f, req in _FILES if req and not (d / f).exists()
                ]
                if still_missing:
                    raise RuntimeError(f"incomplete: {still_missing}")
                _translator_cache.clear()
                _download_alerted = False  # 成功后复位告警去重
                logger.info("local MT model ready at %s (via %s)", d, endpoint)
                return d
            except Exception as exc:  # noqa: BLE001 — 换下一端点
                errors.append(f"{endpoint}: {exc}")
                logger.warning("endpoint failed (%s): %s", endpoint, exc)

    reason = "; ".join(errors) or "unknown"
    logger.warning("local MT model download failed on all endpoints: %s", reason)
    if not _download_alerted:
        _download_alerted = True
        _alert(
            "🔴 本地翻译模型下载失败\n"
            f"{reason[:300]}\n\n"
            "可在设置切换下载端点后重试，或将引擎切回 API 三步法。"
        )
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
            "本地翻译依赖缺失（sentencepiece）——请重新 uv sync"
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


# ---------- 文本清洗 + localize_text（自 media.py 迁入，D-v0.23） ----------

def _clean_nonzh_translation_text(text: str) -> str:
    """非中文译文清洗（v0.11.3）：去全部标点、保留词间距（与中文
    clean_zh_subtitle_text 的"去空格"语义不同——英文挤掉空格会糊成一片）；
    句边界（. ! ? …）折成单空格——script_to_srt 断句依赖。
    """
    parts = re.split(r"[.!?…]+", text)
    out: list[str] = []
    for part in parts:
        part = re.sub(
            r"[\"'\u201c\u201d\u2018\u2019\uff08\uff09()\[\]{}<>\uff0c,\u3001\uff1a:;\uff1b;\u00b7\u2022\-_\u2014\u2013\uff5e~\uff20#$%^&*+=`|/\\]+",
            " ", part,
        )
        part = re.sub(r"\s+", " ", part).strip()
        if part and not part.isdigit():  # 编号残留（"1." → "1"）不落字幕
            out.append(part)
    return " ".join(out)


def _clean_translation_text(text: str) -> str:
    """翻译文本后置清洗（v0.11.2，v0.11.3 全语言化）：字幕不需要标点——

    - 去除句首/句尾标点（LLM 常在句首补"，"）
    - v0.11.3：任何语言译文一律去全部标点（用户诉求：翻译不带标点），
      句边界保留单空格（script_to_srt 断句依赖）
    """
    from backend.pipeline.producers.subtitles import (
        _LOCALIZE_LEAD_PUNCT,
        clean_zh_subtitle_text,
    )

    t = _LOCALIZE_LEAD_PUNCT.sub("", (text or "").strip())
    t = t.strip(" .,;:!?。！？…—")
    if not t:
        return ""
    if any("\u4e00" <= ch <= "\u9fff" for ch in t):
        return clean_zh_subtitle_text(t)
    return _clean_nonzh_translation_text(t)


async def _localize_text(
    text: str, target_lang: str, source_lang: str | None = None,
) -> str:
    """旁白/字幕本地化——本地 Opus-MT en→zh 单步直翻（v0.22.x 去 API 化，D-189）。

    旧 LLM 三步法随翻译去 API 化整体移除；机翻质量对字幕场景够用
    （调研横评记 D-188）。语言对守卫：仅 en→zh 介入，其他对返回原文。
    失败语义不变：回退原文，不阻塞产线。
    """
    if not text.strip():
        return text
    if not ((source_lang or "").startswith("en") and target_lang == "zh-CN"):
        return text
    try:
        out = await translate_local(text)
        return _clean_translation_text(out) if out.strip() else _clean_translation_text(text)
    except Exception as exc:  # noqa: BLE001 — 翻译失败回退原文，不阻塞生产
        logger.warning(
            "localize %s→%s failed (%s) — keeping original",
            source_lang or "?", target_lang, exc,
        )
        return _clean_translation_text(text)
