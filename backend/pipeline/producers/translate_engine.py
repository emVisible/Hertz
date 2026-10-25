"""本地翻译引擎（v0.22.x）：Opus-MT en→zh（ct2 格式）via ctranslate2。

- 模型按需下载（约 300MB，float16 ct2）到 data/models/opus-mt-en-zh；
  下载端点经 pipeline_hf_endpoint 切换镜像（国内网络场景，与转写模型共用一项）
- tokenizer 用 SentencePiece 直读 source/target.spm——不引入 transformers
  重依赖（sentencepiece 与 ctranslate2 均为主依赖；任一不可导入时引擎不可用，
  调用方保留原文不阻塞）
- 推理跑 CPU（int8），与 faster-whisper 共享 ctranslate2 运行时
- 解码带 D-234 的防循环护栏（参数 + 折叠 + 密度截断），字幕不会出现
  「正在 正在 正在」这类退化重复
"""

import asyncio
import collections
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

# ---------- 解码退化护栏（D-234） ----------
#
# Opus-MT 在 ct2 默认解码下会进**重复循环**（字幕上的「正在 正在 正在…」），
# 实测 11 条源文里 10 条超标（循环或密度 ≥0.35），连正常句子也复读——不是边角料。参数是第一道，
# 下面两道后处理是兜底：换一批输入仍可能退化，不能把用户可见的正确性押在
# 一次扫参上。扫参过程与取值依据见 D-234（rp=1.5 是 11 条上唯一 0/11 的档：
# 1.25 → 2/11、1.3 → 1/11）。
_REPETITION_PENALTY = 1.5
_NO_REPEAT_NGRAM_SIZE = 3
# 密度阈值定标（改它必先重跑 tests/test_translate_engine.py 的双向判据）：
# 手写正常句 0.000 / 真实机翻中等输出 0.314 vs 事故样本折叠后最低 1.600
_DUP_RATIO_THRESHOLD = 0.35
_DUP_NGRAM = 4

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


def _translate_kwargs(token_lists: list[list[str]]) -> dict:
    """ct2 解码参数（D-234）。

    `max_decoding_length` 按源长度放开（64~2048）：ct2 默认 256 是**硬顶**，
    实测 1012 字源文止步 428 字、结尾卡在循环中途没有收尾标点——截断发生在
    解码中途，调用方无从分辨「译完了」和「被顶断了」。
    """
    longest = max((len(toks) for toks in token_lists), default=1)
    return {
        "repetition_penalty": _REPETITION_PENALTY,
        "no_repeat_ngram_size": _NO_REPEAT_NGRAM_SIZE,
        "disable_unk": True,
        "max_decoding_length": max(64, min(2048, longest * 4 + 64)),
    }


# 密度必须量在**用户实际看到的形态**上：字幕出库前会被
# `subtitles.clean_zh_subtitle_text` 摘掉全部标点，而标点会把回声隔断——
# 2026-10-13-18 生产字幕里 4 条可见密度 ≥0.35（0.738/0.424/1.000/0.727），
# 给它们每 5 字插一个逗号（clean 后逐字回到生产原文），不归一化实测
# 0.312/0.395/0.000/0.000——三条跌到阈值下整堵墙漏网。
# 判据：`test_dup_ratio_measures_through_punctuation`。
# 字符类与 `subtitles._ZH_PUNCT_RE` 对齐，判据在
# `test_norm_matches_clean_zh_subtitle_text`——那边改了这边不跟，必红。
# （字符类写错过两次：`（）\(）` 漏掉半角 `)`、`〈><>` 漏掉 `〉`——
# 判据上线当天两个全抓出来，此后这边的字符类只许跟着清洗链改。）
_NOISE_RE = re.compile(
    r"[\s。！？!?；;…‥，,、：:·•"
    r"“”\"'‘’「」『』（）\(\)【】\[\]《》〈〉<>"
    r"～~﹣－—–‐\-_/\\|@#$%^&*+=`]+"
)


def _norm(text: str) -> str:
    """归一化到清洗后的可见形态（去标点 + 去空白）。"""
    return _NOISE_RE.sub("", text or "")


def _dup_ratio(text: str) -> float:
    """重复密度：被「出现 ≥2 次的 4-gram」覆盖的字符占比（归一化后计）。

    实测分布（定阈值的依据）：手写正常句 0.000，正常样本最高 0.340
    （2026-10-13-18 生产原句），事故样本折叠后最低 1.600；同片的生产墙
    0.424 必须被拦下——0.35 站在 (0.340, 0.424] 这个窗口里，双向改都有判据咬。
    **同字 4-gram 不计**（「哈哈哈哈」整段都是均匀 gram，会把密度顶到 0.4
    误伤正常句）：单字连排归 `_collapse_repetition` 管，密度只管多字回声。
    """
    s = _norm(text)
    if len(s) < _DUP_NGRAM:
        return 0.0
    grams = [
        g
        for g in (s[i : i + _DUP_NGRAM] for i in range(len(s) - _DUP_NGRAM + 1))
        if len(set(g)) > 1
    ]
    if not grams:
        return 0.0
    counts = collections.Counter(grams)
    return sum(len(g) for g in grams if counts[g] > 1) / len(s)


# 同段连出 ≥3 次 / 同字连出 ≥5 次——解码循环的两种形态（「正在 正在 正在」
# 与「看不见看不见看不见」）。下限是刻意的：单字 3–4 连（「哈哈哈」「哈哈哈哈」）
# 是人话，不许动；6 连以上（事故现场的「空空空空空空」）才认作垃圾。
_LOOP_RE = re.compile(r"(.{2,}?)\1{2,}", re.DOTALL)
_CHAR_RUN_RE = re.compile(r"(.)\1{4,}")
# 收口用的边界：空白与中英文标点——截断落在最后一个边界之后，不留半截词
_BOUNDARY_CHARS = " \t，,。.！!？?；;：:…—~、《》「」()（）"


def _collapse_repetition(text: str) -> str:
    """折叠第一道兜底：循环段只留一份。

    每次替换都严格缩短（≥6 字换 ≤4 字 / 4 字换 1 字），必然终止。
    """
    out = text or ""
    while True:
        m = _CHAR_RUN_RE.search(out) or _LOOP_RE.search(out)
        if not m:
            return out
        out = out[: m.start()] + m.group(1) + out[m.end() :]


def _longest_clean_prefix(s: str, threshold: float, floor: int = 4) -> int:
    """s（已归一化——去标点去空白，即清洗后的可见形态）里，
    重复密度始终 < threshold 的最长前缀长度。

    floor 是「一个位置都不满足」时的兜底长度，必须落在**必然干净**的位置：
    4 = 一个 4-gram 的长度，此时串里只有一个 gram、谈不上重复，密度必为 0。
    曾是 8——8 字回声（「我告訴她我告訴她」）恰好整串落进兜底，原样放回，
    护栏在它身上等于没开（2026-10-13-18 生产 cue 实测：兜底片段密度 1.0）。
    正常文本超阈值才进这里，收得再短也不影响正常句（判据
    `test_trim_degenerate_catches_production_walls` 咬这里）。
    """
    counts: dict[str, int] = {}
    dup = 0
    cut = 0
    for i in range(len(s) - _DUP_NGRAM + 1):
        g = s[i : i + _DUP_NGRAM]
        if len(set(g)) > 1:  # 与 _dup_ratio 同一口径：同字 gram 不计入密度
            seen = counts.get(g, 0)
            # 一份→两份时两份都变重复（+2n），此后每多一份再 +n
            dup += 2 * _DUP_NGRAM if seen == 1 else (_DUP_NGRAM if seen >= 2 else 0)
            counts[g] = seen + 1
        pos = i + _DUP_NGRAM
        if pos >= floor and dup / pos < threshold:
            cut = pos
    return cut or min(floor, len(s))


def _trim_degenerate(text: str) -> str:
    """折叠第二道兜底：**近似**重复（逐字差一点、折叠抓不住的那类）超阈值时，
    截到最长的干净前缀——宁可短，也不把回声送到用户眼前。

    度量在归一化形态上做（与 `_dup_ratio` 同一口径），截断位置再映射回
    原文——标点只隔断回声、不承载信息，量它等于让清洗层替重复打掩护。
    """
    if _dup_ratio(text) < _DUP_RATIO_THRESHOLD:
        return text
    norm = _norm(text)
    cut = _longest_clean_prefix(norm, _DUP_RATIO_THRESHOLD)
    # 归一化坐标 → 原文坐标：keep[i] 是被计入密度的第 i 个字符的原文位置
    keep = [i for i, ch in enumerate(text) if not _NOISE_RE.match(ch)]
    if not keep or cut <= 0:
        return text
    piece = text[: keep[min(cut, len(keep)) - 1] + 1]
    # 在词/句边界收口——直接砍在第 cut 个字上会切出「你完全被完全」这种半截词
    last = max((i for i, ch in enumerate(piece) if ch in _BOUNDARY_CHARS), default=-1)
    if last >= 3:  # 边界前至少留 4 个字，否则宁可不收口
        piece = piece[: last + 1]
    out = piece.strip(" ，,。.！!？?；;：:…—-~")
    return out if len(out) >= 2 else piece.strip()


async def translate_batch_local(texts: list[str]) -> list[str]:
    """批量本地翻译（en→zh，单次 ct2 调用）。依赖缺失/模型未就绪 → RuntimeError。

    输出先过 D-234 的两道护栏（折叠循环 → 密度截断）再交调用方；
    标点清洗仍归调用方的既有清洗链。
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
        results = translator.translate_batch(
            token_lists, max_batch_size=32, **_translate_kwargs(token_lists)
        )
        return [
            _trim_degenerate(
                _collapse_repetition(tgt_spm.decode(r.hypotheses[0]).strip())
            )
            for r in results
        ]

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
