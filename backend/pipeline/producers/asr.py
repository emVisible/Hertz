"""ASR — 原声转写（v0.8.9，对齐原项目 subtitle.py transcribe_with_whisper /
transcribe_with_xinference）。

翻译生产方式（translate）= 提取视频原话 → 中文字幕。转写双通道：
xinference STT 服务优先（快，OpenAI 兼容 multipart），faster-whisper 本地
CPU（base/int8）兜底。faster-whisper 是主依赖（v0.31 B1——曾在可选组 asr 里，
而 CI 与 dev 一律跑裸 uv sync，导致打包版与开发态同时不可用）。
未安装时 asr_available() 返回 False，调用方回退旁白翻译（不阻塞生产）。
本地模型只认 `data_dir/models/whisper/<档位>`（v0.32 S4，路径权威在
`infrastructure/paths`）——档位与下载端点在设置 → 流水线 可配。

v0.11.1 时间轴对齐（专业字幕口径）：whisper 通道改为词级时间戳
（word_timestamps=True + vad 过滤静音）→ _words_to_cues 按说话者节奏
（停顿/标点/长度）断句 → 保留原声真实位置写入 SRT。此前整段文本
重构后按词数权重重新铺满总时长，字幕位置与音频严重错位。
"""

import asyncio
import logging
import math
import re
from pathlib import Path

from backend.config import settings
from backend.infrastructure import alerts, hf, paths
from backend.pipeline.producers.probe import probe_has_audio

logger = logging.getLogger(__name__)

# 断句参数（v0.11.1，专业字幕口径）
_PAUSE_GAP = 0.35      # 词间停顿 ≥ 0.35s → 断句（说话者自然停顿）
_MAX_EN_WORDS = 11     # 英文 cue 词数上限（每行可读性）
_MAX_ZH_CHARS = 22     # 中文 cue 字数上限（对齐项目字幕 22 字红线）
_MAX_CUE_SPAN = 3.5    # 单 cue 跨度硬上限（无标点长句不许糊成一长条）
_MIN_CUE_DUR = 0.35    # 低于此时长的 cue 并入相邻 cue（一闪而过不可读）

_SENT_END_RE = re.compile(r"[.!?。！？；;…]\s*$")

# 繁体检测（v0.11.2）：base 模型中文常输出繁体——含这些字符触发简体重转
#
# v0.32 S3 扩充：原 63 字集**漏掉了打包版实测输出的整句**——
# 「今天天氣不錯,我打算去公園離走走,順便錄一段雨嬰草稿事實」判繁体为 False，
# 于是纠偏根本不触发（字幕产线与工坊同样受影响）。补的都是繁体独有字形，
# 其简体写法（气错园录顺实语婴）绝不进集合——否则简体文本会误触发一次
# 额外 whisper 重转（白烧 CPU）。tests 里两条断言分别钉住「实测句可识别」
# 与「简体字不在集内」。
_TRADITIONAL_CHARS = frozenset(
    "這橋撐從裡們當體還馬電門開關對應該聽華飛車來個時間邊長樣億萬義鳥"
    "說話見建築點兩國寫讀買賣東練習龍鳳歸還為於無與卻後乾淨寧願緣紅"
    "氣錯園錄順實語嬰圖塊壇畫眾盡據處慮頭題腳臉"
)


def _has_traditional(text: str) -> bool:
    return any(ch in _TRADITIONAL_CHARS for ch in (text or ""))

_WHISPER_IMPORTED = False
try:  # 主依赖（v0.31 B1）；导入失败时 whisper_available() 返回 False 走降级
    from faster_whisper import WhisperModel  # type: ignore

    _WHISPER_IMPORTED = True
except ImportError:  # pragma: no cover — 未装 extra 的正常降级路径
    WhisperModel = None  # type: ignore[assignment,misc]

_whisper_model = None
_whisper_key = ""
_whisper_lock = asyncio.Lock()

_WHISPER_ALERT_KEY = "whisper_model_download"


class AsrUnavailableError(RuntimeError):
    """引擎不可导入 / 模型拿不到——调用方（工坊端点）据此回 502。

    状态码不能再靠猜异常文案决定：S4 之前 `studio.py` 用 `"faster-whisper" in str(exc)`
    判 502，模型未就绪的新文案一换，端点就从 502 退成裸 500（本轮产物实测抓到）。
    """


def whisper_available() -> bool:
    return _WHISPER_IMPORTED


def whisper_model_name() -> str:
    """当前档位（单一口径）：`settings.pipeline_whisper_model`，空/空白回落 base。

    档位只此一源——能力矩阵、下载、加载、设置页都读它，改完即生效（重启不需要）。
    """
    return (str(getattr(settings, "pipeline_whisper_model", "") or "").strip() or "base")


def _whisper_repo_id(name: str) -> str:
    """档位别名 → HF repo id。

    先问 faster-whisper 自己的注册表：`large`→large-v3、`turbo`→
    mobiuslabsgmbh/…、`distil-*`→另一个 org，这些都不是简单拼接（1.2.1 实测 19 条
    里 8 条不符合 `Systran/faster-whisper-<name>`）。查不到时按 HF 惯例兜底。
    """
    try:
        from faster_whisper import utils as fw_utils

        repo = (getattr(fw_utils, "_MODELS", None) or {}).get(name)
        if repo:
            return str(repo)
    except Exception as exc:  # noqa: BLE001 — 注册表是私有名，库改了就走兜底而不是让转写崩
        logger.debug("faster_whisper._MODELS lookup failed: %s", exc)
    return name if "/" in name else f"Systran/{paths.WHISPER_REPO_PREFIX}-{name}"


async def ensure_model(force: bool = False) -> Path | None:
    """把配置的 whisper 模型下到 `data_dir/models/whisper`（端点：配置→官方→镜像）。

    就绪即返回，不碰网络。全部端点失败 → 逐端点原因入日志 + 单次告警，返回 None。

    **绝不回退 `~/.cache/huggingface`**：那是应用之外的目录，本机就躺着别的程序
    留下的 whisper 模型；静默借用会让「当前用哪档模型」在两处真相间漂移，用户在
    设置页切档位看不到变化，`HERTZ_DATA_DIR` 隔离也形同被绕过。
    """
    name = whisper_model_name()
    d = paths.whisper_model_dir(name)
    if not force and paths.whisper_model_ready(name):
        return d
    ok, errors = await hf.download_files(
        _whisper_repo_id(name),
        paths.WHISPER_FILES,
        d,
        hf.endpoint_candidates(),
    )
    if not ok:
        reason = "; ".join(errors) or "unknown"
        logger.warning(
            "whisper model %s download failed on all endpoints: %s", name, reason
        )
        alerts.notify_once(
            _WHISPER_ALERT_KEY,
            f"🔴 本地转写模型（{name}）下载失败\n"
            f"{reason[:300]}\n\n"
            "可在设置 → 流水线 切换下载端点（如镜像 hf-mirror）后点「下载转写模型」重试。",
        )
        return None
    alerts.reset(_WHISPER_ALERT_KEY)  # 成功后复位，让下次失败仍可告警一次
    return d


def xinference_configured() -> bool:
    return bool((settings.xinference_stt_model_id or "").strip())


def asr_available() -> bool:
    """任一 ASR 通道可用（xinference 服务配置 或 本地 whisper 已装）。"""
    return xinference_configured() or whisper_available()


async def _get_whisper():
    """懒加载 faster-whisper（int8/CPU），模型目录由 `ensure_model` 定在 data_dir 下。

    缓存键含「档位 @ 目录」：设置页改了档位或数据目录，下一次转写就重建——
    S4 之前没有这层失效，切档位只在重启后生效，且模型悄悄落在 `~/.cache`。
    """
    global _whisper_model, _whisper_key
    name = whisper_model_name()
    key = f"{name}@{paths.whisper_model_dir(name)}"
    if _whisper_model is not None and _whisper_key == key:
        return _whisper_model
    async with _whisper_lock:
        if _whisper_model is not None and _whisper_key == key:
            return _whisper_model
        if not _WHISPER_IMPORTED:
            raise AsrUnavailableError("faster-whisper 不可用 — 执行 uv sync 安装主依赖")
        model_dir = await ensure_model()
        if model_dir is None:
            raise AsrUnavailableError(
                f"whisper 模型未就绪且下载失败（{name}）"
                "——设置 → 流水线 可切换下载端点后重试"
            )
        model = await asyncio.to_thread(
            WhisperModel, str(model_dir), device="cpu", compute_type="int8"
        )
        _whisper_model, _whisper_key = model, key
        return model


def _is_zh(text: str) -> bool:
    return any("\u4e00" <= ch <= "\u9fff" for ch in text)


def _join_cue_texts(*texts: str) -> str:
    """词/句拼接：中文无空格直接拼（whisper 中文字符不带空格），其余单词间留一个空格。"""
    joined = " ".join(t.strip() for t in texts if t.strip())
    if _is_zh(joined):
        return re.sub(r"\s+", "", joined)
    return re.sub(r"\s+", " ", joined).strip()


def _words_to_cues(
    words: list[tuple[float, float, str]],
) -> list[tuple[float, float, str]]:
    """把 whisper 词级时间戳按说话者节奏分组为字幕 cue（v0.11.1）：

    - 词间停顿 ≥ _PAUSE_GAP → 断句（说话者自然停顿，停顿少于阈值则连句）
    - 句末标点且当前 cue ≥ 2 词 → 断句（说话者完成一个意群）
    - 英文 ≥ _MAX_EN_WORDS 词 / 中文 ≥ _MAX_ZH_CHARS 字 → 硬截断（过长语流）
    - cue 跨度 > _MAX_CUE_SPAN 且 ≥ 2 词 → 硬截断（防无标点长句糊条）
    - 时长 < _MIN_CUE_DUR 的碎片并入相邻 cue（一闪而过不可读）

    返回 (start, end, text)——时间戳即原声真实位置，供 _write_srt_cues 直写。
    """
    if not words:
        return []
    cues: list[list[tuple[float, float, str]]] = [[]]
    for start, end, text in words:
        if end <= start or not (math.isfinite(start) and math.isfinite(end)):
            continue  # 非法时间戳（NaN/倒置）不进 cue
        cur = cues[-1]
        if cur:
            prev_end = cur[-1][1]
            has_zh = _is_zh("".join(w[2] for w in cur))
            length = sum(
                len(w[2].strip())
                for w in cur
            ) if has_zh else sum(
                len(w[2].strip().split()) for w in cur
            )
            break_cue = (
                start - prev_end >= _PAUSE_GAP
                or (_SENT_END_RE.search(cur[-1][2]) and len(cur) >= 2)
                or length >= (_MAX_ZH_CHARS if has_zh else _MAX_EN_WORDS)
                or (start - cur[0][0] >= _MAX_CUE_SPAN and len(cur) >= 2)
            )
            if break_cue:
                cues.append([])
        cues[-1].append((start, end, text))

    merged: list[tuple[float, float, str]] = []
    for cue in cues:
        if not cue:
            continue
        start, end = cue[0][0], cue[-1][1]
        text = _join_cue_texts(*(w[2] for w in cue))
        if not text:
            continue
        if merged and end - start < _MIN_CUE_DUR:
            ps, pe, pt = merged[-1]
            # 仅当与上一 cue 紧邻（真延续）才并入——隔着长停顿的碎片
            # 保持独立 cue（并入会凭空吞掉整段停顿）
            if start - pe < _PAUSE_GAP:
                merged[-1] = (ps, max(pe, end), _join_cue_texts(pt, text))
                continue
        merged.append((start, end, text))
    if len(merged) >= 2 and merged[0][1] - merged[0][0] < _MIN_CUE_DUR:
        s0, e0, t0 = merged.pop(0)
        ns, ne, nt = merged[0]
        merged[0] = (ns, max(ne, e0), _join_cue_texts(t0, nt))
    return merged


def _collect_words(segments) -> list[tuple[float, float, str]]:
    """从 whisper 段提取词级时间戳（v0.11.1：过滤 NaN/倒置/空白词）。"""
    words: list[tuple[float, float, str]] = []
    for seg in segments:
        for w in (seg.words or []):
            word_text = (w.word or "").strip()
            if not word_text:
                continue
            start, end = float(w.start), float(w.end)
            if (
                math.isnan(start) or math.isnan(end)
                or math.isinf(start) or math.isinf(end)
                or end <= start
            ):
                continue
            words.append((start, end, word_text))
    return words


_SIMPLIFIED_PROMPT = "以下是简体中文的普通话。"


async def transcribe_cues(
    media_path: Path, *, language: str | None = None
) -> list[tuple[float, float, str]]:
    """faster-whisper 转写 → 词级时间戳 → 按说话者节奏断句的 cue。

    **全仓唯一的 whisper 调用出口**（v0.32 S3）：字幕产线与脚本工坊共享同一套
    时间轴口径与同一套繁简纠偏。此前工坊在路由里自己调了一次 `model.transcribe`，
    结果 v0.11.2 的纠偏只作用于字幕，工坊中文实测输出繁体。

    失败时抛异常（由调用方决定降级或报错）——「静默返回 None」的语义留在
    `transcribe_with_whisper`（生产链路依赖它回退旁白字幕）。
    """
    model = await _get_whisper()
    segments, _ = await asyncio.to_thread(
        model.transcribe, str(media_path), language=language or None,
        word_timestamps=True, vad_filter=True,
    )
    words = _collect_words(segments)
    # base 模型 zh 常偏繁体，且繁体状态下误认生僻字 → 带简体 prompt 重转一遍
    if not language and words and _has_traditional("".join(w[2] for w in words)):
        logger.info("zh 转写结果含繁体 — 带简体 initial_prompt 重转（唯一纠偏点）")
        segments, _ = await asyncio.to_thread(
            model.transcribe, str(media_path), language="zh",
            word_timestamps=True, vad_filter=True,
            initial_prompt=_SIMPLIFIED_PROMPT,
        )
        words = _collect_words(segments)
    return _words_to_cues(words)


async def transcribe_with_whisper(
    media_path: Path, out_srt: Path, *, language: str | None = None
) -> Path | None:
    """faster-whisper 转写 → cue → 写 SRT（生产链路用，失败返回 None 供回退）。

    v0.11.1：不再把整段文本拼起来按词数权重重新铺满总时长（会丢失原声
    位置造成字幕错位）——word_timestamps=True 取每个词的绝对时间，
    _words_to_cues 按停顿/标点/长度断句，_write_srt_cues 直写原始时间轴。
    v0.11.2 的繁简纠偏与 vad 静音过滤现已收在 `transcribe_cues` 单一出口。
    """
    from backend.pipeline.producers.media import _write_srt_cues

    try:
        cues = await transcribe_cues(media_path, language=language)
        if not cues:
            return None
        out_srt.parent.mkdir(parents=True, exist_ok=True)
        _write_srt_cues(out_srt, cues)
        return out_srt
    except Exception as exc:  # noqa: BLE001 — 转写失败回退脚本字幕
        logger.warning("whisper transcription failed: %s", exc)
        return None


async def transcribe_with_xinference(media_path: Path, out_srt: Path) -> Path | None:
    """xinference STT 服务（OpenAI 兼容 /v1/audio/transcriptions multipart）。"""
    import httpx

    if not xinference_configured():
        return None
    url = f"{settings.xinference_stt_base_url.rstrip('/')}/audio/transcriptions"
    headers = {
        "Authorization": f"Bearer {settings.xinference_api_key or 'not-needed'}"
    }
    data = {"model": settings.xinference_stt_model_id}
    try:
        audio = await asyncio.to_thread(media_path.read_bytes)
        # xinference 是本地服务（默认 127.0.0.1:9997）——绕过环境代理，同 openai_compat。
        async with httpx.AsyncClient(timeout=120.0, trust_env=False) as client:
            resp = await client.post(
                url,
                headers=headers,
                files={"file": ("audio.wav", audio, "application/octet-stream")},
                data=data,
            )
            resp.raise_for_status()
            result = resp.json()
        text = (
            str((result or {}).get("text") or "").strip()
            if isinstance(result, dict)
            else str(result).strip()
        )
        if not text:
            return None
        out_srt.parent.mkdir(parents=True, exist_ok=True)
        # xinference 无分段时间戳——按句断行后分布到真实音频时长
        # （v0.11.1：传 probe_audio_duration 而非 0.0，避免每字估时把
        # 长对话压成几秒；无音轨探测失败时退回每字估时）
        from backend.pipeline.producers.media import probe_audio_duration, script_to_srt

        audio_dur = 0.0
        try:
            audio_dur = await probe_audio_duration(media_path) or 0.0
        except Exception as exc:  # noqa: BLE001 — 探测失败回退每字估时
            logger.warning("audio duration probe failed for xinference subs: %s", exc)
        script_to_srt(text, audio_dur, out_srt)
        return out_srt
    except Exception as exc:  # noqa: BLE001 — 服务不可用回退 whisper/脚本
        logger.warning("xinference transcription failed: %s", exc)
        return None


async def transcribe(media_path: Path, out_srt: Path) -> Path | None:
    """双通道转写：xinference 优先（快），whisper 本地兜底。"""
    got = await transcribe_with_xinference(media_path, out_srt)
    if got is not None:
        return got
    if whisper_available():
        return await transcribe_with_whisper(media_path, out_srt)
    return None


# ---------- ASR 字幕（自 media.py 迁入，D-v0.23） ----------

async def _cues_already_target(cues, target_lang: str) -> bool:
    """转写文本已是目标语言则跳过 LLM 翻译（中文原声视频不绕一圈）。

    v0.10：翻译只对「原声非目标语言」发生——目标为中文且转写已含
    中文字符（≥3 字）时原文即目标语言，直接复用转写（省一次 LLM 调用）。
    """
    if not target_lang.lower().startswith("zh"):
        return False
    zh_count = sum(
        1
        for _, _, text in cues
        for ch in (text or " ")
        if "\u4e00" <= ch <= "\u9fff"
    )
    return zh_count >= 3


async def _asr_subtitles(
    ai,  # AIRouter — 避免循环导入，不加类型标注
    raw_path: Path,
    directory: Path,
    target_lang: str = "zh-CN",
    *,
    translate: bool = True,
    asr_srt: Path | None = None,
    task_id: str | None = None,
) -> tuple[Path, str] | None:
    """ASR 原声字幕（v0.8.9 起，v0.10 语义修正：字幕/翻译数据源 = 视频原声）：

    转写原声音轨（xinference 优先 / whisper 兜底）→ 可选 LLM 逐段翻译 →
    target_lang SRT（保留原声时间戳；translate=True 且目标为中文时译文标点
    统一清洗）。返回 (srt, 全文)；任一环节失败返回 None。
    translate=False：转写原文直接作字幕（原声语言），不翻译、不清洗。

    v0.11：asr_srt 传入时复用 produce 步骤的预转写结果（脚本生成已依赖
    转写全文，同一视频不转写两遍）。
    """
    from backend.pipeline.producers.subtitles import (
        _translate_srt_cues,
        _write_srt_cues,
        clean_zh_subtitle_text,
        parse_srt_cues,
    )

    if asr_srt is None:
        has_audio = await probe_has_audio(raw_path)
        if not has_audio:
            return None  # 图片帖等无原声——回退旁白字幕
        asr_srt = directory / "asr.srt"
        got = await transcribe(raw_path, asr_srt)
        if got is None:
            return None
    cues = parse_srt_cues(asr_srt)
    if not cues:
        return None
    if translate and not await _cues_already_target(cues, target_lang):
        zh_cues = await _translate_srt_cues(cues, target_lang=target_lang)
        # v0.8.9 标点清洗（对齐原项目 _rewrite_srt_strip_zh_punct）：
        # ASR 译文可能残留标点，统一清洗（保留时间戳）
        zh_cues = [
            (s, e, clean_zh_subtitle_text(t) or " ")
            for s, e, t in zh_cues
        ]
    else:
        zh_cues = cues
    zh_srt = directory / "subs.srt"
    _write_srt_cues(zh_srt, zh_cues)
    full = " ".join(t for _, _, t in zh_cues).strip()
    return zh_srt, full
