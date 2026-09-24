"""本地翻译引擎（v0.22.x）：Opus-MT en→zh（ct2 格式）via ctranslate2。

- 模型按需下载（约 300MB，float16 ct2）到 data/models/opus-mt-en-zh；
  下载端点经 pipeline_hf_endpoint 切换镜像（国内网络场景，与转写模型共用一项）
- tokenizer 用 SentencePiece 直读 source/target.spm——不引入 transformers
  重依赖（sentencepiece 与 ctranslate2 均为主依赖；任一不可导入时引擎不可用，
  调用方保留原文不阻塞）
- 推理跑 CPU（int8），与 faster-whisper 共享 ctranslate2 运行时
"""

import asyncio
import logging
import re
from pathlib import Path

from backend.infrastructure import alerts, hf, paths

logger = logging.getLogger(__name__)

_MODEL_REPO = "gaudi/opus-mt-en-zh-ctranslate2"
_ALERT_KEY = "local_mt_model_download"
# (文件名, 是否必需)——权威在 infrastructure/paths（就绪探测与下载清单必须同一份，
# 否则「下哪些」与「缺哪些算没就绪」会长成两处各自漂移）
_FILES: list[tuple[str, bool]] = list(paths.LOCAL_MT_FILES)

_translator_cache: dict = {}


def model_dir() -> Path:
    return paths.local_mt_dir()


def deps_available() -> bool:
    """sentencepiece/ctranslate2 可导入（两者均为主依赖，v0.31 B1）。"""
    try:
        import ctranslate2  # noqa: F401
        import sentencepiece  # noqa: F401

        return True
    except ImportError:
        return False


async def ensure_model(force: bool = False) -> Path | None:
    """确保 ct2 翻译模型就绪；多端点依序尝试（配置端点→官方→镜像）。

    传输细节（流式写盘、`.part` 原子改名、可选文件 404、幂等补缺）在
    `infrastructure/hf.download_files`——whisper 引擎走的是同一条路。
    全部失败：逐端点原因进日志 + Telegram 单次告警（去重与成功后复位由
    `infrastructure/alerts` 负责），返回 None 由调用方保留原文。
    """
    d = model_dir()
    if not force and paths.local_mt_ready():
        return d

    ok, errors = await hf.download_files(
        _MODEL_REPO, _FILES, d, hf.endpoint_candidates()
    )
    if not ok:
        reason = "; ".join(errors) or "unknown"
        logger.warning("local MT model download failed on all endpoints: %s", reason)
        alerts.notify_once(
            _ALERT_KEY,
            "🔴 本地翻译模型下载失败\n"
            f"{reason[:300]}\n\n"
            "可在设置 → 流水线 切换下载端点（如镜像 hf-mirror）后点「下载本地翻译模型」重试。",
        )
        return None
    _translator_cache.clear()
    alerts.reset(_ALERT_KEY)  # 成功后复位，让下次失败仍可告警一次
    return d


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
