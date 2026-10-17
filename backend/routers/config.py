"""Config endpoints: read effective config (sanitized), write runtime overrides.

Secrets never leave the backend unmasked (AXIOM §8.2): the API key is only
returned masked; writing it is allowed (single-user desktop, stored in the
local data/runtime.yaml) but reading it back is impossible.
"""

import logging
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.config import Settings, runtime_config, settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/config", tags=["config"])

# Fields allowed for runtime override (public, non-secret, UI-adjustable)
RUNTIME_ALLOWLIST = {
    # comfyui_base_url 仅用于首次种子（v3.0 起图像配置以 ai_providers 表为准）
    "comfyui_base_url",
    "deepseek_base_url",
    "deepseek_model",
    "data_dir",
    "output_dir",
    "log_dir",
    "assets_root",
    "pipeline_min_score",
    "pipeline_heuristic_scoring",
    "pipeline_collect_limit",
    "pipeline_auto_collect_minutes",
    "pipeline_publish_target",
    # 采集源列表（v0.4 A4）：设置页增删 subreddit 源
    "pipeline_sources",
    # 多源扩展（v0.22）：AI 原创故事成本闸 + RSS 订阅表
    "pipeline_ai_story_per_tick",
    "pipeline_rss_feeds",
    # 热点监控通道（v0.16）：rising 高频 + 三段词法预筛
    "pipeline_watch_enabled",
    "pipeline_watch_subreddits",
    "pipeline_watch_sort",
    "pipeline_watch_minutes",
    "pipeline_watch_keywords_any",
    "pipeline_watch_keywords_all",
    "pipeline_watch_exclude",
    "pipeline_watch_min_score",
    # Telegram 审核 Bot（v0.18）
    "telegram_enabled",
    "telegram_bot_token",
    "telegram_chat_id",
    "telegram_minutes",
    "telegram_weekly",
    # 字幕样式（v0.4 B1）：字号/描边/加粗/对齐；v0.11.2 增淡入淡出/底部留白
    "pipeline_subtitle_font_size",
    "pipeline_subtitle_outline",
    "pipeline_subtitle_bold",
    "pipeline_subtitle_alignment",
    "pipeline_subtitle_fade_ms",
    "pipeline_subtitle_margin_bottom",
    # 字幕/翻译/配音语言（v0.10）：生成语言与配音源语言
    "pipeline_subtitle_lang",
    "pipeline_translate_source_lang",
    "pipeline_tts_text_source",
    # 三步翻译法（v0.15）：旁白直译→反思→意译
    # 本地模型下载端点（v0.22.x 起；v0.32 S4 收成一个：翻译与转写引擎共用）
    "pipeline_hf_endpoint",
    # 本地转写模型档位（v0.32 S4）
    "pipeline_whisper_model",
    # 发布队列（v0.12）：自动发布产能/开关/转正数/轮询间隔
    "pipeline_auto_publish",
    "pipeline_auto_publish_daily_limit",
    "pipeline_auto_promote_daily",
    "pipeline_auto_publish_tick_minutes",
    # 发布策略引擎（v0.13）：健康度动态配额/内容分层/槽位约束
    "pipeline_strategy_enabled",
    "pipeline_strategy_dry_run",
    "pipeline_strategy_base_daily",
    "pipeline_strategy_warmup_floor",
    "pipeline_strategy_warmup_step",
    "pipeline_strategy_drop_ratio",
    "pipeline_strategy_cooldown_floor_views",
    "pipeline_strategy_cooldown_streak_days",
    "pipeline_strategy_min_same_tid_gap_h",
    "pipeline_strategy_premier_score",
    # 模型单价（v0.5 E 成本估算）：model_key → {prompt, completion}（美元/百万 tokens）
    "ai_model_prices",
    # 频道人设记忆（v0.18）：注入脚本与标题 prompt
    "channel_persona",
    # 运营者自用规范与固定计划（v0.34）：只读给人看，不进任何 prompt
    "creator_norms",
    "standing_plan",
    # 成本报表币种（v0.14.1）：CNY|USD + USD→目标币汇率
    "cost_currency",
    "cost_usd_rate",
    # 月度预算（v0.17）：阶梯提示 50%/80%/95%（不阻断）
    "cost_monthly_budget",
    # 角色分配经 PUT /api/ai/roles 写入（唯一写入口，见 routers/ai.py）
    # Single-user desktop: API keys live in the local runtime.yaml.
    # They are never returned by GET — only set via PATCH.
    "deepseek_api_key",
    "llm_api_key",
    "pipeline_reddit_client_id",
    "pipeline_reddit_client_secret",
    "pipeline_reddit_cookie",
    # v0.11.9：设置页保存全量 overrides 含此项——缺省会整体 400，
    # 导致「配置保存成功」但 runtime.yaml 未落盘（发布目标恒 NOOP）
    "pipeline_reddit_cookies_browser",
    # v0.37：并发上限 / 调度时区 / 剪贴板监控开关。
    # 并发上限原先写死在 factory/concurrency.py；调度时区写死 Asia/Shanghai；
    # 剪贴板监控压根没有开关。三者都不该需要改源码才能调整。
    "concurrency_llm",
    "concurrency_image",
    "concurrency_tts",
    "concurrency_download",
    "concurrency_pipeline",
    "scheduler_timezone",
    "clipboard_monitor_enabled",
    # v0.37 批次一：发布调度与成本闸门。这些字段一直存在、代码一直在读，
    # 但不在 allowlist 里 → PATCH 直接 400 → 设置页根本渲染不出来。
    "pipeline_publish_windows",
    "pipeline_publish_min_interval_min",
    "pipeline_publish_jitter_min",
    "pipeline_bili_dtime_min_hours",
    "pipeline_bili_default_tid",
    "pipeline_auto_approve",
    "pipeline_auto_approve_after_hours",
    "pipeline_score_max_per_run",
    "pipeline_score_max_per_day",
    # v0.37 批次二：旁白/TTS 与 ASR。注意这里的不对称——`pipeline_subtitle_lang`
    # 和 `pipeline_tts_text_source` 一直有 UI，而 `pipeline_narration_lang`（旁白
    # 用什么语言）和 `pipeline_tts_rate`（语速）没有。同一个功能的一半暴露、
    # 一半藏起来，用户只会以为后者不存在。
    "pipeline_narration_lang",
    "pipeline_tts_rate",
    "pipeline_narration_min_words",
    "pipeline_narration_max_words",
    "pipeline_narration_silent_below",
    "pipeline_enable_asr",
    "xinference_stt_base_url",
    "xinference_stt_model_id",
    "xinference_api_key",
    # v0.37 批次三：下载韧性、采集门槛、并发上限、备份。
    "pipeline_download_delay_seconds",
    "pipeline_download_cooling_base_seconds",
    "pipeline_download_cooling_max_seconds",
    "pipeline_cdn_circuit_403",
    "pipeline_cdn_circuit_cooldown",
    "pipeline_prefilter_min_reddit_score",
    "pipeline_prefilter_min_upvote_ratio",
    "backup_enabled",
    "backup_keep",
    "pipeline_integrity_minutes",
    # v0.37：成片画幅（原先 5 个文件共 8 处写死 720p）
    "pipeline_video_width",
    "pipeline_video_height",
    "pipeline_video_fps",
    # v0.37：node 22 路径（原先只认环境变量，设置页无从配置）
    "node_bin",
    # v0.38：发布可靠性（重试 + 限速熔断）
    "pipeline_publish_max_attempts",
    "pipeline_publish_retry_base_seconds",
    "pipeline_publish_cooldown_seconds",
    "pipeline_publish_cooldown_max_seconds",
    # v0.38：跨日排期（此前 6 处调用点硬传 1，用户无法制定超过 24h 的计划）
    "pipeline_publish_lookahead_days",
    # v0.38：条目重试预算（retry_count 此前只写不读）
    "pipeline_max_item_retries",
}

SECRET_FIELDS = {
    "deepseek_api_key",
    "llm_api_key",
    "secret_key",
    "database_url",
    "pipeline_reddit_client_secret",
    "pipeline_reddit_cookie",
}


def _mask_secret(value: str) -> str | None:
    if not value:
        return None
    if len(value) <= 8:
        return "••••"
    return f"••••{value[-4:]}"


@router.get("")
async def get_config() -> dict:
    base = settings.model_dump()
    overrides = runtime_config.load()
    base.update(overrides)
    # 素材根目录（v0.8.6）：null = 默认 data_dir——与 library.py/docs.py 消费侧
    # 语义一致（或 settings.data_dir），否则设置页输入框拿到 null 显示为空
    if not base.get("assets_root"):
        base["assets_root"] = str(settings.data_dir)
    public = {k: v for k, v in base.items() if k not in SECRET_FIELDS and not k.startswith("_")}
    public["runtime_overrides"] = {k: v for k, v in overrides.items() if k in RUNTIME_ALLOWLIST}
    api_key = str(base.get("llm_api_key") or base.get("deepseek_api_key") or "")
    public["llm_api_key_masked"] = _mask_secret(api_key)
    public["llm_api_key_set"] = bool(api_key)
    # Reddit OAuth（v0.3.5）：secret 只写不读（§8.2），UI 用 set 标志显示已配置
    public["pipeline_reddit_client_id_set"] = bool(base.get("pipeline_reddit_client_id"))
    public["pipeline_reddit_client_secret_set"] = bool(
        base.get("pipeline_reddit_client_secret")
    )
    return public


class ConfigUpdate(BaseModel):
    overrides: dict


#: 类默认值本身就是 Path 的字段——只有它们的「逐字相同」是可判定的。
_PATH_DEFAULT_FIELDS: dict[str, Path] = {
    name: field.default
    for name, field in Settings.model_fields.items()
    if isinstance(field.default, Path)
}


def _prune_redundant_path_defaults(data: dict) -> dict:
    """摘掉与类默认值逐字相同的路径字段，让 runtime.yaml 只装真覆盖。

    runtime.yaml 的语义是**覆盖**（AXIOM §22.3），不是设置页表单的存档。而设置页
    `save()` 提交的是「草稿与配置的差集」——用户没碰过的字段本不该出现在 PATCH
    里，可一旦某次保存（或旧版本）把默认值也存了进去，它就会永久遮住以后的
    新默认值：v0.36 改 `log_dir` 默认值，本机却因为文件里一行 `log_dir: logs`
    继续往 logs/ 写，且毫无报错。

    摘掉它不改变任何生效值——默认值本来就等于它。`assets_root` 的默认值是
    `None`，所以 `assets_root: data` 这种「显式指回 data_dir」不会被误摘，
    docs.py / library.py 直接读 `runtime_config.load()["assets_root"]` 的
    语义保持不变。
    """
    out = dict(data)
    for name, default in _PATH_DEFAULT_FIELDS.items():
        value = out.get(name)
        if value is None or name not in out:
            continue
        try:
            # 默认值是仓库相对路径（`data/logs`），设置页可能回传同一个目录的
            # 绝对路径——两者指的是同一个地方，比较前先都解析成绝对路径。
            if Path(str(value)).resolve() == default.resolve():
                out.pop(name)
        except (TypeError, ValueError, OSError):  # 存了不可解析的路径串：留着，让读侧报错
            continue
    return out


@router.patch("")
async def update_config(req: ConfigUpdate) -> dict:
    disallowed = set(req.overrides) - RUNTIME_ALLOWLIST
    if disallowed:
        raise HTTPException(
            status_code=400, detail=f"Not runtime-configurable: {sorted(disallowed)}"
        )
    merged = _prune_redundant_path_defaults(runtime_config.load())
    merged.update(_prune_redundant_path_defaults(req.overrides))
    runtime_config.save(merged)
    if any(str(key).startswith("pipeline_reddit_client_") for key in req.overrides):
        # 保存凭证是这次操作的前一半，能力矩阵（reddit_auth 条目）是后一半，得互相看见。
        # DepsCard 读的是 deps 缓存，而这条目是纯配置读（不探测、不联网）——不刷新的话
        # 「刚填完」要等到下次重启/手动重测才算数（同 _spawn_model_download 下载完成后
        # 刷缓存那个先例）。刷新失败不影响已落盘的配置，只降级成「矩阵暂时陈旧」。
        from backend.infrastructure.deps import refresh_dependencies

        try:
            await refresh_dependencies()
        except Exception as exc:  # noqa: BLE001 — 配置已存，缓存随后由启动/手动重测补上
            logger.warning("deps refresh after reddit credential save failed: %s", exc)
    return {"applied": {k: v for k, v in req.overrides.items()}}

