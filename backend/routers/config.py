"""Config endpoints: read effective config (sanitized), write runtime overrides.

Secrets never leave the backend unmasked (AXIOM §8.2): the API key is only
returned masked; writing it is allowed (single-user desktop, stored in the
local data/runtime.yaml) but reading it back is impossible.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.config import runtime_config, settings

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
    "pipeline_collect_limit",
    "pipeline_auto_collect_minutes",
    "pipeline_publish_target",
    # 采集源列表（v0.4 A4）：设置页增删 subreddit 源
    "pipeline_sources",
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
    "pipeline_translate_three_pass",
    # 发布队列（v0.12）：自动发布产能/开关/转正数/轮询间隔
    "pipeline_auto_publish",
    "pipeline_auto_publish_daily_limit",
    "pipeline_auto_promote_daily",
    "pipeline_auto_publish_tick_minutes",
    # 发布策略引擎（v0.13）：健康度动态配额/内容分层/槽位约束
    "pipeline_strategy_enabled",
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
    # 成本报表币种（v0.14.1）：CNY|USD + USD→目标币汇率
    "cost_currency",
    "cost_usd_rate",
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
    return {"applied": {k: v for k, v in req.overrides.items()}}

