"""Producers — turn a downloaded item into a finished video (script → tts →
subtitles → edit → cover). Every producer is best-effort and idempotent:
it writes artifacts under ``output/pipeline/{item_id}/`` and returns a
small result dict for the produce step to persist on the item.
"""

import asyncio
import logging
import uuid
from pathlib import Path

from backend.ai.router import AIRouter
from backend.config import settings
from backend.infrastructure.storage import FileStore
from backend.library.thumbnails import find_ffmpeg
from backend.models import script_keys as sk
from backend.pipeline.cancel import (
    ItemCancelledError,
    reset_active_item,
    set_active_item,
)

# Re-export from new homes for backward compat (tests / retranslate.py / story.py)
from backend.pipeline.producers.asr import (  # noqa: F401
    _asr_subtitles,
    _cues_already_target,
)
from backend.pipeline.producers.common import (
    ProducerError,
    _raise_if_cancelled,
    _run_cmd,
)
from backend.pipeline.producers.compose import (  # noqa: F401
    _find_bgm,
    _render_cue_png,
    compose_video,
    subtitles_filter_available,
)
from backend.pipeline.producers.cover import (  # noqa: F401
    extract_random_cover,
    generate_cover,
)
from backend.pipeline.producers.narration import (  # noqa: F401
    apply_narration_delay,
    check_script_compliance,
    fit_script_to_budget,
    generate_script,
    narration_budget,
    narration_start_offset,
    synthesize_tts,
)
from backend.pipeline.producers.probe import (  # noqa: F401
    probe_audio_duration,
    probe_duration,
    probe_has_audio,
)
from backend.pipeline.producers.probe import (
    video_stream_params as _probe_video_params,
)
from backend.pipeline.producers.story import (  # noqa: F401
    produce_story_item,
)
from backend.pipeline.producers.subtitles import (  # noqa: F401
    _EN_LINE_WORDS,
    _FONT_NAMES,
    _LOCALIZE_LEAD_PUNCT,
    _SENT_SPLIT_RE,
    _ZH_PUNCT_RE,
    _allocate_slots,
    _en_beat_weights,
    _fit_cues_to_beats,
    _fmt_ass_cs,
    _fmt_ts,
    _join_cue_parts,
    _split_en_sentences,
    _split_zh_sentences,
    _subtitle_cache_hit,
    _subtitle_font,
    _translate_srt_cues,
    _wrap_lines,
    _write_srt,
    _write_srt_cues,
    clean_zh_subtitle_text,
    parse_srt_cues,
    script_to_srt,
    srt_to_ass,
    subtitle_font_family,
)
from backend.pipeline.producers.translate_engine import (  # noqa: F401
    _clean_nonzh_translation_text,
    _clean_translation_text,
    _localize_text,
)

logger = logging.getLogger(__name__)


def _artifacts_dir(files: FileStore, item) -> Path:
    # 锚定 data_dir（cwd 无关）：产物目录 = data/output/pipeline/<output_dir>/
    # output_dir 为结构化名（2026-08-04-01），与 download 步骤一致；旧数据兜底 hex
    slug = (item.output_dir or f"pipeline/{item.id.hex}").split("/")[-1]
    return files.output_root() / "pipeline" / slug


async def _assemble_compilation(item, files: FileStore, directory: Path) -> Path:
    """把合集条目引用的 N 段素材装配成一条中间产物，返回其路径。

    形状来自 `Item.clips`（迁移 wave32_item_clips）：
        {"clips": [{"item_id": uuid, "transition": str, "transition_s": float}, ...]}

    片头复用栏目 `intro_config`（在 `produce_item` 的单点挂钩里前置，见那里）；
    这里只负责**片段之间**的拼接与片尾。

    引用的是 item_id 而不是 raw_path 拷贝：打回重制会重新分配 output_dir，
    路径引用会失效，所以每次装配都现查一次源条目的 raw_path。
    """
    from backend.models.item import Item as _Item
    from backend.models.session import session_factory
    from backend.pipeline.producers.assemble import assemble_clips

    plan = dict(getattr(item, "clips", None) or {})
    specs = list(plan.get("clips") or [])
    if not specs:
        raise ProducerError("合集条目没有片段配置")

    async with session_factory() as session:
        # 保序查询：顺序由 clips 数组决定，不靠数据库返回序
        by_id: dict = {}
        for spec in specs:
            raw_id = spec.get("item_id")
            try:
                row = await session.get(_Item, uuid.UUID(str(raw_id)))
            except (ValueError, AttributeError, TypeError):
                raise ProducerError(f"合集片段引用无效：{raw_id}") from None
            if row is None:
                raise ProducerError(f"合集片段不存在：{raw_id}")
            if not row.raw_path:
                raise ProducerError(f"合集片段尚未下载：{row.title[:40]}")
            by_id[str(raw_id)] = (Path(files.resolve(row.raw_path)), row.title)

    clips: list[dict] = []
    for index, spec in enumerate(specs):
        entry = by_id.get(str(spec.get("item_id")))
        if entry is None:
            raise ProducerError(f"合集片段不存在：{spec.get('item_id')}")
        clips.append({
            "path": str(entry[0]),
            # 第一段没有「入场转场」可言
            "transition": spec.get("transition") if index else "cut",
            "transition_s": spec.get("transition_s"),
        })

    assembled = directory / "assembled.mp4"
    info = await assemble_clips(clips, assembled)
    logger.info(
        "compilation assembled: %d clips → %s (%.1fs, %dx%d)",
        info["clips"], assembled.name, info["duration_s"],
        info["width"], info["height"],
    )

    # 片尾：渲染器复用栏目片头那套（story._render_story_bg），只在成片后面接，
    # 不参与片段之间的转场计算——所以放在 assemble 之后、compose 之前。
    outro_cfg = dict(plan.get("outro") or {})
    if outro_cfg.get("enabled"):
        try:
            with_outro = await _append_outro(item, assembled, outro_cfg)
            if with_outro is not None:
                assembled = with_outro
        except Exception:  # noqa: BLE001 — 片尾是加分项，不许拖垮整条合集
            logger.warning("合集片尾失败，保留无片尾成片", exc_info=True)

    return assembled


async def _append_outro(item, main: Path, cfg: dict) -> Path | None:
    """成片尾部接一张结尾卡。失败返回 None（调用方保留原片）。

    沿用 `_prepend_channel_intro` 的非破坏性契约：任一步失败都不改原片。
    """
    from backend.library.thumbnails import find_ffmpeg
    from backend.pipeline.producers.story import _render_story_bg

    ffmpeg = find_ffmpeg()
    if ffmpeg is None:
        return None
    duration = max(1.0, min(float(cfg.get("duration_s") or 2.5), 10.0))
    subtitle = str(cfg.get("subtitle") or "").strip()

    params = await _probe_video_params(main)
    if params is None:
        logger.warning("outro skipped: video unprobeable")
        return None
    width, height, fps, has_audio = params

    card = main.parent / "outro_card.png"
    await asyncio.to_thread(_render_story_bg, "感谢观看", card, credit=subtitle)
    outro = main.parent / "outro_clip.mp4"

    vf = f"scale={width}:{height}"
    cmd = [str(ffmpeg), "-y", "-loop", "1", "-i", str(card)]
    if has_audio:
        cmd += ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100"]
    cmd += [
        "-t", f"{duration:.3f}", "-vf", vf, "-r", f"{fps:.3f}",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "medium",
    ]
    cmd += ["-c:a", "aac", "-b:a", "160k", "-shortest"] if has_audio else ["-an"]
    cmd.append(str(outro))
    await _run_cmd(cmd)

    merged = main.parent / "final_with_outro.mp4"
    concat_list = main.parent / "concat_outro.txt"
    await asyncio.to_thread(
        concat_list.write_text,
        f"file '{main.as_posix()}'\nfile '{outro.as_posix()}'\n",
    )
    try:
        # 参数一致（outro 按主片参数编码）→ 可以 -c copy，不重编码
        await _run_cmd([
            str(ffmpeg), "-y",
            "-f", "concat", "-safe", "0", "-i", str(concat_list),
            "-c", "copy", str(merged),
        ])
        if not (merged.exists() and merged.stat().st_size >= 1024):
            return None
        return merged
    finally:
        await asyncio.to_thread(concat_list.unlink, missing_ok=True)


async def produce_item(
    ai: AIRouter, files: FileStore, item, existing_script: dict | None = None
) -> dict:
    """Full production for one item. Returns artifact dict; raises ProducerError
    only when no producible media exists (item-level failures). Individual
    artifact failures degrade gracefully (missing cover, subs-only, etc.).

    v0.2.7：existing_script 提供时（重新翻译）跳过脚本生成——只重跑
    TTS/字幕/合成，基于原视频重新翻译。
    v0.3.3：生产方式模块（item.produce_options）——直发/配音/字幕/翻译/静音
    按模块执行；直发跳过全部加工（原片即成片），仍抽封面 + phash。

    wave11 取消制作：入口登记活动条目（ContextVar）——产线内部检查点/
    _run_cmd 轮询据此查取消标志；收尾复位。无 id 的测试桩不受影响。
    """
    token = set_active_item(getattr(item, "id", None))
    try:
        artifacts = await _produce_item(ai, files, item, existing_script)
        # v0.22 栏目片头（非破坏性）：未绑定栏目/未启用/任一失败 → 原成片不变。
        # 单点汇聚挂钩——video_raw 与 story 两条产线的产物统一前置标题卡
        video = artifacts.get("video")
        if video and video.get("path"):
            try:
                from backend.pipeline.helpers import get_channel

                channel = await get_channel(getattr(item, "channel_key", None))
                if channel is not None and channel.intro_enabled():
                    video["path"] = await _prepend_channel_intro(
                        channel, Path(video["path"])
                    )
                    video["intro"] = True
            except ItemCancelledError:
                raise
            except Exception:  # noqa: BLE001 — 片头失败不阻塞生产（降级原成片）
                logger.warning(
                    "channel intro prepend failed — keep original video",
                    exc_info=True,
                )
        return artifacts
    finally:
        reset_active_item(token)


async def _produce_item(
    ai: AIRouter, files: FileStore, item, existing_script: dict | None = None
) -> dict:
    """Full production for one item. Returns artifact dict; raises ProducerError
    only when no producible media exists (item-level failures). Individual
    artifact failures degrade gracefully (missing cover, subs-only, etc.).

    v0.2.7：existing_script 提供时（重新翻译）跳过脚本生成——只重跑
    TTS/字幕/合成，基于原视频重新翻译。
    v0.3.3：生产方式模块（item.produce_options）——直发/配音/字幕/翻译/静音
    按模块执行；直发跳过全部加工（原片即成片），仍抽封面 + phash。
    """
    # v0.11.9：默认生产方式 = 直发——produce_options 从未设置（None/{}）
    # 的新入库未加工条目原片直接发布（对齐前端 DEFAULT_PRODUCE_OPTIONS）；
    # 部分显式设置（如 voice+subtitle）保持 v0.9 语义（翻译+字幕兜底），
    # 不被直发劫持（此前 setdefault 顺序曾导致 voice/subtitle 与 passthrough 并存）。
    # v0.22.x：默认/部分设置语义抽至 helpers.normalize_produce_flags 单一真相源
    from backend.pipeline.helpers import normalize_produce_flags

    opts = normalize_produce_flags(item.produce_options)
    passthrough = bool(opts.get("passthrough"))
    want_voice = bool(opts.get("voice"))
    want_subtitle = bool(opts.get("subtitle"))
    want_translate = bool(opts.get("translate"))
    muted = bool(opts.get("mute"))

    # v0.11.7 文字故事产线：text_only 帖无 raw 媒体，走独立分支
    # （selftext → 中文旁白 → TTS → 图文合成）
    if getattr(item, "item_type", "") == "text_only":
        return await produce_story_item(ai, files, item, existing_script)

    # v0.35 多素材合集（迁移 wave32_item_clips）：合集条目**本身没有 raw_path**，
    # 它由若干条已下载素材拼成。先装配、再把 raw_path 指向装配产物——
    # 这一行之后**下游全部自动正确**：时长探测、ASR、旁白预算、字幕烧录、
    # 封面（多点采样会在所有片段里挑最好的一帧）、phash 判重，都基于
    # 拼接后的成片，而不是第一段素材。
    #
    # 为什么装配放在 raw 校验**之前**：合集条目的 raw_path 天然为 NULL，
    # 先校验会直接抛 "raw media missing"——那是给单条目的判据。
    if getattr(item, "clips", None):
        directory = _artifacts_dir(files, item)
        await asyncio.to_thread(directory.mkdir, parents=True, exist_ok=True)
        raw_path = await _assemble_compilation(item, files, directory)
    else:
        # v0.8.8（AXIOM 25/34）：先校验 raw 存在再建目录——此前 mkdir 在 raw
        # 校验之前，raw 缺失的失败会遗留空目录（测试曾积累 300+ 个 hex 空目录）
        raw_path = Path(files.resolve(item.raw_path)) if item.raw_path else None
        if raw_path is None or not raw_path.exists():
            raise ProducerError("raw media missing")
        directory = _artifacts_dir(files, item)
        await asyncio.to_thread(directory.mkdir, parents=True, exist_ok=True)

    # 直发（v0.3.3）：不加工——原片即产物（cover/phash 仍做，供审核与去重）
    if passthrough:
        artifacts: dict = {
            "script": None, "compliance": None, "directory": str(directory),
            "video": {"path": str(raw_path), "passthrough": True},
        }
        from backend.pipeline.phash import compute_phash

        artifacts["phash"] = await compute_phash(str(raw_path))
        cover_path = directory / "cover.jpg"
        try:
            artifacts["cover"] = await generate_cover(raw_path, cover_path)
        except ProducerError as exc:
            logger.warning("cover generation failed: %s", exc)
            artifacts["cover"] = None
        # 直发也补 B 站中文包装（v0.8.5）：发布元数据不依赖加工模式
        from backend.pipeline.package import generate_packaging

        script = await generate_packaging(
            ai, item, {sk.MODE: "passthrough", sk.NARRATION: ""}
        )
        artifacts["script"] = script
        return artifacts

    # v0.8.9 对齐原项目 narration_budget：先探测时长 → 按预算词数生成旁白
    duration = await probe_duration(raw_path)
    if duration <= 0:
        duration = 15.0  # unknown duration → fixed budget
    budget = await narration_budget(duration)

    # v0.11 内容源 = 视频原声（视频里说的话）：生产任何内容之前先转写——
    # 旁白（script）、字幕、翻译、配音全部基于转写文本；无音轨（图片帖/
    # 静音视频）或 ASR 通道不可用/失败 → 回退标题+简介（content_source 标注）。
    transcript: dict | None = None
    if bool(getattr(settings, "pipeline_enable_asr", True)):
        try:
            if await probe_has_audio(raw_path):
                from backend.pipeline.producers.asr import transcribe

                asr_srt = directory / "asr.srt"
                got = await transcribe(raw_path, asr_srt)
                if got is not None:
                    cues = parse_srt_cues(asr_srt)
                    if cues:
                        transcript = {
                            "srt": asr_srt,
                            "cues": cues,
                            "text": " ".join(t for _, _, t in cues).strip(),
                        }
        except Exception:  # noqa: BLE001 — 转写失败不阻塞生产（回退简介）
            logger.warning("ASR transcription failed — falling back to metadata")
    _raise_if_cancelled()

    script = existing_script or await generate_script(
        ai, item, max_words=budget["max_words"] or 120, video_duration=duration,
        content=(transcript or {}).get("text"),
    )
    # v0.8.9 迁移数据兜底：旧项目脚本（CandleBone 时代）只有 script 键无
    # narration——重制时旁白会变成字符串 "None" 烧进字幕。无 narration 时重生成
    if not str(script.get(sk.NARRATION) or "").strip():
        logger.warning("existing script lacks narration — regenerating")
        script = await generate_script(
            ai, item, max_words=budget["max_words"] or 120, video_duration=duration,
            content=(transcript or {}).get("text"),
        )
    compliance = check_script_compliance(script)
    _raise_if_cancelled()
    artifacts = {
        "script": script, "compliance": compliance, "directory": str(directory),
    }
    if transcript:
        artifacts["transcript"] = {"path": str(transcript["srt"])}

    # 处理语言（v0.2.7，参考原项目 locales）：英文旁白 + 中文字幕可配置；
    # v0.3.3：翻译模块 = 仅字幕翻译（原声保留）
    narration_text = str(script.get(sk.NARRATION) or "")[:1000]
    narration_lang = str(
        getattr(settings, "pipeline_narration_lang", "en-US") or "en-US"
    )
    subtitle_lang = str(
        getattr(settings, "pipeline_subtitle_lang", "zh-CN") or "zh-CN"
    )
    # 翻译源语言（v0.8.9 方向扩展）：显式配置优先，空 = 沿用旁白语言
    translate_source = str(
        getattr(settings, "pipeline_translate_source_lang", "") or ""
    ).strip() or narration_lang
    # 字幕文本（v0.8.9 修复）：翻译模块 → 旁白本地化为 subtitle_lang（默认 zh-CN）。
    # 此前条件 `not want_translate or subtitle_lang == "zh-CN"` 把「目标语言是中文」
    # 误当「无需翻译」——默认配置下翻译永远不生效（英文旁白原样入字幕）。
    # 正确语义：源语言与目标字幕语言不同才需要翻译
    # v0.22.x 缓存复用：脚本未变且已有译文 → 跳过 LLM 翻译（省 3×token 三步法）
    cached_sub = _subtitle_cache_hit(
        existing_script, narration_text, translate_source, subtitle_lang
    )
    if want_translate and cached_sub is not None:
        subtitle_text = cached_sub
    elif want_translate and translate_source != subtitle_lang:
        subtitle_text = await _localize_text(
            narration_text, subtitle_lang, source_lang=translate_source,
        )
        if isinstance(script, dict):
            script[sk.SUB_SOURCE] = translate_source
            script[sk.SUB_TARGET] = subtitle_lang
    else:
        subtitle_text = narration_text
    # 中文字幕持久化（v0.8.5）：B 站简介构建复用（subtitle_zh 首句 + 署名）
    script[sk.SUBTITLE_ZH] = subtitle_text.strip()

    # 字幕模块 · 原声字幕（v0.11：转写先行，复用预转写结果不重复转写）
    # v0.10 语义修正：字幕/翻译的数据源 = 视频原声（视频中的人说的话），
    # 旁白文案仅作回退——此前字幕基于简介派生的旁白文案，与用户语义
    # 「提取视频原话→（翻译→）字幕」不符：
    # - translate：原声转写 → 逐段翻译成 subtitle_lang（目标语言字幕）
    # - subtitle（无 translate）：原声转写原文（保留原声语言与时间戳）
    # - 原声缺失（图片帖/静音视频）/ ASR 通道不可用/失败 → 配音后回退旁白文案
    srt_path = None
    asr_subtitle = None
    if (
        want_subtitle
        and bool(getattr(settings, "pipeline_enable_asr", True))
    ):
        try:
            asr_subtitle = await _asr_subtitles(
                ai, raw_path, directory,
                target_lang=subtitle_lang, translate=want_translate,
                asr_srt=(transcript or {}).get("srt"),
                task_id=f"item:{item.id}",
            )
        except Exception:  # noqa: BLE001 — ASR 失败回退旁白字幕
            logger.warning(
                "ASR subtitles failed, falling back to narration subs",
                exc_info=True,
            )
        if asr_subtitle:
            srt_path, asr_text = asr_subtitle
            script[sk.SUBTITLE_ZH] = asr_text.strip()
            # 字幕来源标记（v0.22.x）：审核卡 ⚠️ 徽章数据源
            script[sk.SUBTITLE_SOURCE] = sk.SUB_FROM_ASR
            artifacts["subtitle"] = {"path": str(srt_path), "source": "asr"}
        else:
            logger.warning(
                "[produce] 原声字幕不可用（无音轨/转写失败/依赖缺失）"
                "——字幕回退旁白文案，条目将打 narration_fallback 标记"
            )

    # 配音模块：旁白文本按 narration_lang 本地化（v0.2.7 语义）后 TTS 裁词重试；
    # 非配音模块 → 无旁白。v0.8.9：音色内容自适应（pick_voice）+ 语速（rate）
    if want_voice:
        # v0.9：配音文本来源可选——跟字幕译文配音（tts_text_source=subtitle）
        # 或跟旁白原文本地化配音（默认 script）
        # v0.11：subtitle 源 = script["subtitle_zh"]（转写译文优先，旁白文案兜底）
        tts_src = getattr(settings, "pipeline_tts_text_source", "script") or "script"
        subtitle_zh = str(script.get(sk.SUBTITLE_ZH) or subtitle_text or "").strip()
        if (tts_src == "subtitle" and want_translate and subtitle_zh):
            tts_text = subtitle_zh
        else:
            # v0.22.x：脚本按 narration_lang 生成，旁白本就是目标语言——
            # 旧版此处对 en→en 的「本地化」为恒等调用，随去 API 化直接取旁白
            tts_text = narration_text
        # 音色（v0.8.9，对齐原项目 pick_voice）：注册表 tts 角色手动配置优先，
        # auto/未配置 → 内容自适应（tech→男声 / 暖心→女声 / 奇观男偏 + 随机）
        # v0.22 栏目固定音色：最高优先级——未绑定栏目时为 None，走原链（非破坏性）
        try:
            from backend.pipeline.helpers import get_channel

            _channel = await get_channel(getattr(item, "channel_key", None))
            channel_voice = (_channel.voice or "").strip() if _channel else ""
            from backend.ai.registry import ProviderRegistry
            from backend.pipeline.producers.tts_voice import pick_voice

            if channel_voice:
                voice = channel_voice
            else:
                resolved = await ProviderRegistry().resolve_role("tts")
                configured = resolved["model_key"] if resolved else ""
                if not configured or configured.lower() in ("auto", "random", "smart"):
                    # v0.9 修复对齐走样：此前表达式恒 None（tags 从未传入内容匹配）
                    voice, _reason = pick_voice(
                        title=item.title,
                        script=tts_text,
                        subreddit=item.subreddit or "",
                        tags=[
                            t.strip()
                            for t in str(script.get(sk.BILI_TAGS) or "").split(",")
                            if t.strip()
                        ],
                        configured="auto",
                    )
                else:
                    voice = configured
        except Exception:  # noqa: BLE001 — 音色解析失败用默认（角色配置）
            voice = ""
        audio_path = directory / "narration.mp3"
        tts = None
        audio_dur = 0.0
        current_text = tts_text
        for attempt in range(3):
            _raise_if_cancelled()
            try:
                candidate = await synthesize_tts(
                    ai, current_text, audio_path, voice=voice or None
                )
            except ProducerError as exc:
                logger.warning(
                    "tts attempt %d failed: %s", attempt + 1, exc
                )
                break
            audio_dur = await probe_duration(audio_path)
            if audio_dur and audio_dur <= duration * 0.98:
                tts = candidate
                break
            # 超预算：按词数裁词（v0.8.9 对齐原项目 fit_script_to_budget，
            # 保句首、补句号——此前按字符比例截断会切断单词/句子）
            budget_words = max(4, int(len(current_text.split()) * max(
                0.3, (duration * 0.9) / max(audio_dur or duration, 1)
            )))
            trimmed = fit_script_to_budget(current_text, budget_words)
            if trimmed == current_text or not trimmed:
                logger.warning(
                    "narration %.1fs exceeds %.1fs budget — cannot trim further",
                    audio_dur or 0, duration * 0.98,
                )
                break
            current_text = trimmed
            logger.warning(
                "narration %.1fs exceeds %.1fs budget — trim to %d words, retry %d/3",
                audio_dur or 0, duration * 0.98, budget_words, attempt + 2,
            )
        artifacts["audio"] = tts

        # 旁白起始延迟（v0.3.0）：音频加起始静音 + 字幕时间线同偏移。
        # v0.8.9：tts_text 同步为最终合成文本（裁词后）——align_script /
        # start_offset 必须对准实际朗读的旁白而非未裁全文
        tts_text = current_text if tts is not None else tts_text
        start_offset = narration_start_offset(tts_text, duration)
        if tts is None:
            # v0.8.9 对齐原项目 _drop_to_subs_only：TTS 3 次仍超/无法裁 → 
            # 放弃配音转纯字幕（无旁白），否则旁白超出视频导致音画继续错位
            logger.warning(
                "TTS still exceeds video after retries — dropping to subs_only"
            )
            artifacts["audio"] = None
            audio_dur = 0.0
            start_offset = 0.0
        elif start_offset > 0:
            try:
                delayed = await apply_narration_delay(
                    Path(artifacts["audio"]["path"]), start_offset
                )
                artifacts["audio"] = {"path": str(delayed), "bytes": artifacts["audio"]["bytes"]}
            except Exception:  # noqa: BLE001 — 延迟失败不影响主流程
                logger.warning("narration delay failed, continuing without offset")
    else:
        artifacts["audio"] = None
        audio_dur = 0.0
        start_offset = 0.0

    # 字幕模块 · 回退旁白字幕（原声缺失/ASR 不可用/失败时兜底——
    # 配音后执行，需要旁白音频时长/起始偏移做时间轴对齐）
    if (
        srt_path is None
        and want_subtitle
        and bool(getattr(settings, "pipeline_enable_asr", True))
    ):
        srt_path = directory / "subs.srt"
        try:
            # v0.8.9 字幕同步（对齐原项目两个制作概念）：
            # 1. voice 模式：字幕时间轴 = 旁白音频实际时长（从 start_offset
            #    起，中文 cue 按英文 TTS beats 词数加权 1:1 对齐）
            # 2. 非 voice 模式（原声记录）：字幕时间轴 = 视频原声音频流的
            #    实际时长（probe_audio_duration）——说话者说完字幕即结束，
            #    不再铺满视频总时长；无音轨（图片帖/静音视频）回退视频时长
            if artifacts.get("audio") is not None:
                timing_dur = min(
                    audio_dur or duration, max(0.5, duration - start_offset)
                )
            else:
                # 无音轨（图片帖/静音视频）时 probe_audio_duration 已
                # 回退容器时长 → min(.., duration) = duration
                timing_dur = min(
                    await probe_audio_duration(raw_path) or duration, duration
                )
            await asyncio.to_thread(
                script_to_srt, subtitle_text, timing_dur, srt_path, start_offset,
                align_script=tts_text if artifacts.get("audio") is not None else None,
            )
            artifacts["subtitle"] = {
                "path": str(srt_path),
                "source": "asr" if asr_subtitle else "script",
            }
            # 降级标记（v0.22.x）：来源非原声时打标——翻译失败场景下
            # 兜底字幕可能是外语原文，前端 ⚠️ 徽章提示不再静默
            script[sk.SUBTITLE_SOURCE] = (
                sk.SUB_FROM_ASR if asr_subtitle else sk.SUB_FROM_NARRATION_FALLBACK
            )
        except Exception:  # noqa: BLE001 — subtitles are best-effort
            srt_path = None

    video_path = directory / "final.mp4"
    narration_file = Path(artifacts["audio"]["path"]) if artifacts.get("audio") else None
    _raise_if_cancelled()
    try:
        edit = await compose_video(
            raw_path, narration_file, srt_path, video_path, muted=muted,
            # v0.9 duck 窗口（对齐原项目 _audio_mix_filters）：旁白区间 =
            # start_offset ~ start_offset + 旁白实际时长；无 TTS 时为 0
            narr_start=start_offset,
            narr_dur=audio_dur,
        )
        artifacts["video"] = edit
    except ProducerError as exc:
        logger.warning("video composition failed: %s", exc)
        artifacts["video"] = None
        # v0.8.9 AXIOM 25：ffmpeg -y 失败可能残留半写文件——best-effort 清理
        try:
            await asyncio.to_thread(video_path.unlink, missing_ok=True)
        except OSError:
            pass

    # v0.8.9 AXIOM 4.6 末端兜底：合成彻底失败时用原片尽力交付——
    # 不伪装完整成功（degraded 标注进产物与 script_json），审核页可见来源
    if artifacts.get("video") is None:
        logger.warning(
            "composition failed — degrading to raw passthrough (AXIOM 4.6)"
        )
        artifacts["video"] = {
            "path": str(raw_path),
            "passthrough": True,
            "degraded": "raw",
        }
        script = dict(artifacts.get("script") or {})
        script[sk.PRODUCED_DEGRADED] = "raw"
        artifacts["script"] = script

    # phash 去重（v0.2.1，参考原项目 Autarkeia block_publish_duplicates）：
    # 平均哈希 → 发布闸门比对已发布条目。
    # v0.11.4：一律用 raw 源片计算——成片 phash 被烧录字幕带/统一缩放主导
    # （实测两个不同源视频的成片 phash 仅差 4 位 → 误判重复），
    # raw 才反映真实内容（同一素材二次加工/直发仍能正确判重）
    if artifacts.get("video") is not None:
        from backend.pipeline.phash import compute_phash

        artifacts["phash"] = await compute_phash(str(raw_path))
        if artifacts["phash"]:
            logger.debug("item phash=%s (raw=%s)", artifacts["phash"], raw_path)
    else:
        artifacts["phash"] = None

    cover_path = directory / "cover.jpg"
    try:
        artifacts["cover"] = await generate_cover(raw_path, cover_path)
    except ProducerError as exc:
        logger.warning("cover generation failed: %s", exc)
        artifacts["cover"] = None

    if artifacts.get("video") is None and artifacts.get("audio") is None:
        raise ProducerError("production produced no usable media")

    # v0.9 成片质量落库（对齐原项目 compose_quality）：烧录方式/音频守卫/
    # 降级项进 script_json，审核卡可见（不静默降级）
    quality = dict((artifacts.get("video") or {}).get("quality") or {})
    if quality:
        script = dict(artifacts.get("script") or {})
        script[sk.COMPOSE_QUALITY] = quality
        artifacts["script"] = script

    # B 站中文包装（v0.8.5，对齐原项目）：bili_title/bili_desc/bili_tags 自动补齐，
    # 发布卡可手动覆盖；LLM 失败 heuristic 兜底
    from backend.pipeline.package import generate_packaging

    artifacts["script"] = await generate_packaging(ai, item, artifacts["script"])

    return artifacts


# ---------- 文字故事产线（v0.11.7 情感频道第二阶段·半自动内容生产） ----------
#
# text_only 帖（Reddit 情感版块：AmItheAsshole/TrueOffMyChest/offmychest…）：
# selftext → LLM 中文故事旁白 → TTS 固定中文音色 → 渐变背景+标题卡 →
# 字幕烧录合成。无原始画面，phash 无意义 → None（去重靠标题指纹）。

# 深紫→暖紫垂直渐变（IP 视觉基调）
async def _prepend_channel_intro(channel, main: Path) -> Path:
    """栏目动态标题卡前置：渲染栏目名底卡 → 按主片参数编码 → concat。

    非破坏性：ffprobe 缺失 / 编码失败 / 产物校验不过 → 返回原成片路径。
    intro_config: {"enabled": true, "duration_s": 3, "subtitle": "..."}
    """
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        logger.warning("intro skipped: ffmpeg unavailable")
        return main
    cfg = channel.intro_config or {}
    if not cfg.get("enabled"):
        return main  # 双保险：调用方已查 intro_enabled，此处兜底
    duration = max(1.0, min(float(cfg.get("duration_s") or 3), 10.0))
    subtitle = str(cfg.get("subtitle") or "").strip()

    params = await _probe_video_params(main)
    if params is None:
        # 主片不可解析（损坏/占位）→ 不做任何替换（非破坏性）
        logger.warning("intro skipped: main video unprobeable")
        return main
    width, height, fps, has_audio = params

    # 标题底卡：复用故事产线 PIL 渐变渲染器（栏目名大字 + 副题署名）
    from backend.pipeline.producers.story import _render_story_bg

    card = main.parent / "intro_card.png"
    await asyncio.to_thread(_render_story_bg, channel.name, card, credit=subtitle)

    intro = main.parent / "intro_clip.mp4"
    vf = f"scale={width}:{height}"
    if has_audio:
        cmd = [
            str(ffmpeg), "-y",
            "-loop", "1", "-i", str(card),
            "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
            "-t", f"{duration:.3f}",
            "-vf", vf, "-r", f"{fps:.3f}",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "medium",
            "-c:a", "aac", "-b:a", "160k",
            "-shortest",
            str(intro),
        ]
    else:
        cmd = [
            str(ffmpeg), "-y",
            "-loop", "1", "-i", str(card),
            "-t", f"{duration:.3f}",
            "-vf", vf, "-r", f"{fps:.3f}",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "medium",
            "-an",
            str(intro),
        ]
    await _run_cmd(cmd)

    merged = main.parent / "final_with_intro.mp4"
    concat_list = main.parent / "concat_intro.txt"
    await asyncio.to_thread(
        concat_list.write_text,
        f"file '{intro.as_posix()}'\nfile '{main.as_posix()}'\n",
    )
    try:
        await _run_cmd([
            str(ffmpeg), "-y",
            "-f", "concat", "-safe", "0", "-i", str(concat_list),
            "-c", "copy",
            str(merged),
        ])
        ok = await asyncio.to_thread(merged.exists) and (
            await asyncio.to_thread(merged.stat)
        ).st_size >= 1024
        if not ok:
            logger.warning("intro concat produced no output — keep original")
            return main
        await asyncio.to_thread(main.unlink)
        await asyncio.to_thread(merged.rename, main)
        return main
    finally:
        for p in (concat_list,):
            await asyncio.to_thread(p.unlink, missing_ok=True)
