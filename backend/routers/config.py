"""Config endpoints: read effective config (sanitized), write runtime overrides.

Secrets never leave the backend unmasked (AXIOM §8.2): the API key is only
returned masked; writing it is allowed (single-user desktop, stored in the
local data/runtime.yaml) but reading it back is impossible.
"""

import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.config import runtime_config, settings

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


@router.patch("")
async def update_config(req: ConfigUpdate) -> dict:
    disallowed = set(req.overrides) - RUNTIME_ALLOWLIST
    if disallowed:
        raise HTTPException(
            status_code=400, detail=f"Not runtime-configurable: {sorted(disallowed)}"
        )
    merged = runtime_config.load()
    merged.update(req.overrides)
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

