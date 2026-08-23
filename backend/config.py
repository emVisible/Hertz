"""Unified configuration for Hertz.

Single source of truth for all backend settings (AXIOM §1.2).
Env vars use the HERTZ_ prefix; values may also live in a root .env file.

Config layering (AXIOM §22.3):
  1. pydantic defaults below (version controlled)
  2. .env / environment variables (secrets, deployment differences)
  3. data/runtime.yaml (RuntimeConfig: user-modifiable runtime overrides)
"""

import os
from pathlib import Path

import yaml
from pydantic_settings import BaseSettings, SettingsConfigDict

# 应用版本单一真相源（v0.11.6 Axiom §1.2 修复）：后端 main.py 引用此处；
# pyproject.toml / frontend·electron package.json 在发版时对齐本值。
APP_VERSION = "0.17.0"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="HERTZ_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Database
    database_url: str = "postgresql+asyncpg://hertz:hertz@localhost:5432/hertz"

    # Ports
    backend_port: int = 8787
    frontend_port: int = 3000

    # Paths
    data_dir: Path = Path("data")
    output_dir: Path = Path("output")
    log_dir: Path = Path("logs")
    # 素材根目录：素材页浏览根（面包屑根），留空 = 当前项目目录（data_dir）
    assets_root: Path | None = None

    # Security
    secret_key: str | None = None  # set via HERTZ_SECRET_KEY; None → auth disabled/fails fast
    access_token_expire_minutes: int = 60

    # AI: LLM（v2.0 起由 Provider 注册表管理；以下字段仅用于首次启动
    # 从环境变量导入默认 DeepSeek Provider，之后以 DB 为准）
    deepseek_api_key: str = ""  # legacy alias — 新配置走 llm_api_key
    deepseek_base_url: str = "https://api.deepseek.com/v1"
    deepseek_model: str = "deepseek-chat"
    # 通用 OpenAI 兼容配置（provider 无关）；留空则用 provider 默认值
    llm_api_key: str = ""
    llm_base_url: str = ""
    llm_model: str = ""

    # AI: Image generation（仅首次种子用；运行期配置以 ai_providers 表为准）
    comfyui_base_url: str = "http://127.0.0.1:8188"

    # Execution pipeline
    pipeline_publish_target: str = "noop"  # noop | bilibili | export
    pipeline_min_score: float = 6.0
    pipeline_collect_limit: int = 25
    # 自动采集间隔（v0.8.1）：scheduler 周期自动入库（0=关闭，仅手动）
    pipeline_auto_collect_minutes: int = 30
    # 采集源列表（v0.8.6）：真实活跃 subreddit（参考原项目冰川采集列表筛选，
    # 内容型短视频友好）；设置页可增删。注意是版块名不是排序词——
    # 旧默认 "hot" 会被 r/hot 近乎无内容 + 403 拖垮整条链路
    pipeline_sources: list[str] = [
        "Damnthatsinteresting",
        "BeAmazed",
        "nextfuckinglevel",
        "interestingasfuck",
        "ThatsInsane",
        "Unexpected",
        "Whatcouldgowrong",
        "PerfectTiming",
        "HumansBeingBros",
        "oddlysatisfying",
    ]
    # 热点监控通道（v0.16，TrendRadar 词法精华借鉴）：对指定 subreddit 以
    # 高频+rising 排序拉取，三段词法预筛（any 命中/all 全含/exclude 否决）后才
    # 入库——把评分额度花在源头更可能爆的内容上。命中的条目仍走正常评分/审核
    # 流水线（不绕过闸门）。默认关闭。
    pipeline_watch_enabled: bool = False
    pipeline_watch_subreddits: str = ""  # 逗号分隔 subreddit 名
    pipeline_watch_sort: str = "rising"  # hot/new/rising/top
    pipeline_watch_minutes: int = 15  # 监控采集间隔（分钟）
    pipeline_watch_keywords_any: str = ""  # 任一命中（空格分词）
    pipeline_watch_keywords_all: str = ""  # 必须全部包含
    pipeline_watch_exclude: str = ""  # 含任一则排除
    pipeline_watch_min_score: int = 0  # reddit_score 门槛（0=不限）
    # 评分成本闸门（v0.2.1，参考原项目 Autarkeia）：单次运行 / 单日 LLM 评分硬限额，
    # 超限跳过评分（条目保持 downloaded，下轮或次日再评）——防 API 费用失控
    pipeline_score_max_per_run: int = 50
    pipeline_score_max_per_day: int = 100
    # 本地排期引擎（v0.2.1，参考原项目 scheduler_utils）：每日发布窗口 + 最小间隔 + 抖动
    pipeline_publish_windows: str = "10:00-12:00,18:00-20:00"
    pipeline_publish_min_interval_min: int = 30
    pipeline_publish_jitter_min: int = 5
    pipeline_publish_lookahead_days: int = 1  # v0.11.5：只排当天（用户需求）
    # 排期发布硬门槛（v0.9 对齐原项目 ensure_bilibili_dtime）：
    # B 站要求 dtime 提交后 ≥5 分钟（v0.11.5 修正：原 4h 过严）；
    # scheduled_at 不足时自动顺延
    pipeline_bili_dtime_min_hours: int = 0
    # 自动发布队列（v0.12）：产能 = 每日自动发布条数上限；
    # 每天首个 tick 从预发布队列自动转正 N 条（pipeline_auto_promote_daily）
    # 到发布队列（自动分配当天窗口槽位），到点自动发布；手动发布不受限制。
    # 总开关默认关闭——开启后请确认 pipeline_publish_target 与凭据就绪
    pipeline_auto_publish: bool = False
    pipeline_auto_publish_daily_limit: int = 5  # 每日自动发布上限（产能）
    pipeline_auto_promote_daily: int = 3  # 每日从预发布自动转正条数（≤ 上限）
    pipeline_auto_publish_tick_minutes: int = 5  # 调度扫描间隔
    # 发布策略引擎（v0.13「逆向算法」）：账号健康度 → 动态配额 → 内容分层选
    # 条目 → 槽位规划（同分区间隔 + 相邻分区去重）。总开关默认关闭——关闭时
    # 转正/产能走上方静态参数（行为与 v0.12 完全一致）；开启后由策略接管，
    # cooldown 日自动停发、caution 减半、新号爬坡。详见 pipeline/strategy.py。
    pipeline_strategy_enabled: bool = False
    pipeline_strategy_base_daily: int = 2  # 策略常态日配额（新号保守起步）
    pipeline_strategy_warmup_floor: int = 30  # 累计发布低于此 = 新号爬坡期
    pipeline_strategy_warmup_step: int = 10  # 每 N 条累计发布 +1 配额（爬坡粒度）
    pipeline_strategy_drop_ratio: float = 0.5  # 本周均播/上周均播低于此 → 配额减半
    pipeline_strategy_cooldown_floor_views: int = 10  # 发布日中位播放地板线
    pipeline_strategy_cooldown_streak_days: int = 2  # 连续地板天数 → 停发冷却
    pipeline_strategy_min_same_tid_gap_h: int = 6  # 同分区间隔下限（防堆量痕迹）
    pipeline_strategy_premier_score: float = 8.0  # AI 分 ≥ 此值优先占黄金槽
    # 自动过审（v0.2.1，参考原项目 auto_approve）：默认关闭；
    # 开启后停留审核队列超过 N 小时的条目自动 approve（人工审核仍是默认路径）
    pipeline_auto_approve: bool = False
    pipeline_auto_approve_after_hours: int = 12
    # B站默认分区 tid（审核未显式设置时使用；0 = 不传，用账号默认）
    pipeline_bili_default_tid: int = 201  # 201 = 知识
    # 处理语言（v0.2.7，参考原项目 locales 配置）：默认英文旁白 + 中文字幕
    # narration_lang: 旁白目标语言（edge-tts 音色对应；zh-CN = 中文旁白）
    # subtitle_lang: 字幕目标语言（zh-CN = 中文字幕；可配 en-US/ja/ko/vi/id/fil/pt-BR 等）
    # translate_source_lang: 翻译源语言（v0.8.9 翻译方向扩展——默认英文旁白翻中文；
    #   配 zh-CN 即中文旁白例子可翻任意目标字幕语言；沿用 narration_lang 时置空）
    pipeline_narration_lang: str = "en-US"
    pipeline_subtitle_lang: str = "zh-CN"
    pipeline_translate_source_lang: str = ""  # 空 = 沿用 narration_lang（默认 en-US）
    # 三步翻译法（v0.15，VideoLingo 精华）：旁白文本 直译→反思→意译（3× token）；
    # 字幕批量保持单步 + 术语表注入。成本敏感可关。
    pipeline_translate_three_pass: bool = True
    # ASR 原声转写（v0.8.9 起，v0.10 语义：字幕/翻译的数据源 = 视频原声）：
    # 字幕生产方式 = 原声转写字幕（原声语言）；翻译生产方式 = 原声转写 →
    # 中文字幕（原声保留、无配音）。无原声（图片帖）自动回退旁白文案字幕。
    # xinference 服务未配置时用本地 faster-whisper
    pipeline_enable_asr: bool = True
    xinference_stt_base_url: str = "http://127.0.0.1:9997/v1"
    xinference_api_key: str = ""
    xinference_stt_model_id: str = ""  # 空 = 不使用 xinference STT
    # 配音（v0.8.9，对齐原项目 tts.py）：语速与旁白预算
    pipeline_tts_rate: str = "+0%"  # edge-tts rate（如 -10% / +15%）
    # 配音文本来源（v0.9）：script = 跟旁白原文（本地化后配音）；
    # subtitle = 跟中文字幕译文配音（需配合 translate）
    pipeline_tts_text_source: str = "script"
    pipeline_narration_silent_below: float = 8.0  # 视频短于此秒数不生成旁白
    pipeline_narration_min_words: int = 6  # 词预算低于此值不生成旁白
    pipeline_narration_max_words: int = 42  # 旁白词数硬上限（原项目 42）
    # 字幕样式（v0.4 B1）：ASS 参数可调——字号/描边宽/加粗/对齐(1底2中3顶)
    # v0.11.2：默认字体换霞鹜文楷（LXGW WenKai，SIL OFL 1.1 免费商用）；
    # 新增淡入淡出毫秒 + 底部留白（原项目字幕过渡参考）
    pipeline_subtitle_font_size: int = 24
    pipeline_subtitle_outline: int = 1
    pipeline_subtitle_bold: bool = False
    pipeline_subtitle_alignment: int = 2
    pipeline_subtitle_fade_ms: int = 300  # 字幕淡入淡出时长（ASS fad / PNG alpha fade）
    pipeline_subtitle_margin_bottom: int = 64  # 距视频底部留白（720p 口径）
    # 下载韧性（v0.2.9，参考原项目 download.py）：条间延迟抖动 + CDN 403 熔断
    pipeline_download_delay_seconds: float = 1.2
    # 下载资源冷却（v0.3.6 冰川式）：按媒体域指数退避冻结，base 起步、max 封顶
    pipeline_download_cooling_base_seconds: int = 300
    pipeline_download_cooling_max_seconds: int = 7200
    pipeline_cdn_circuit_403: int = 3  # 连续 403 达阈值 → 熔断
    pipeline_cdn_circuit_cooldown: int = 600  # 熔断冷却秒数
    # 评分预过滤（v0.3.0，参考原项目 _prefilter_reject）：LLM 前的廉价门槛，
    # 仅当 reddit_score > 0 时生效（RSS/空分源防误杀）
    pipeline_prefilter_min_reddit_score: int = 50
    pipeline_prefilter_min_upvote_ratio: float = 0.85
    # Reddit OAuth（v0.3.5）：匿名请求易被 403 Blocked（TLS/IP 指纹），
    # 配置官方 API 凭证后走 oauth.reddit.com 认证通道（详见 collectors/reddit.py）
    pipeline_reddit_client_id: str = ""
    pipeline_reddit_client_secret: str = ""
    # Reddit Cookie 方案（v0.8.1，参考原项目）：OAuth 个人申请困难——
    # 用浏览器登录 Cookie（字符串直填 / yt-dlp 自动导出 Netscape 文件）
    pipeline_reddit_cookie: str = ""
    pipeline_reddit_cookies_browser: str = ""  # 逗号分隔候选，空=自动 chrome/safari/edge…
    # Test/dev escape hatch: allow http(s) non-public URLs in the pipeline
    # download step (SSRF guard stays on by default — AXIOM §8.1).
    pipeline_allow_loopback_urls: bool = False

    # AI 底座 v2.0：角色 → 模型分配（provider:model），如
    #   ai_roles = {"main": "deepseek:deepseek-chat", "fast": "ollama:qwen2.5:7b"}
    # 未配置角色时 TaskRouter 回退：fast/embedding/image/tts → main → 首个可用 chat
    ai_roles: dict[str, str] = {}
    # 模型单价（v0.5 E 成本估算）：model_key → {prompt, completion}（美元/百万 tokens）
    ai_model_prices: dict[str, dict[str, float]] = {}
    # 频道人设记忆（v0.18）：账号定位/语言调性/红线——注入脚本与标题生成 prompt，
    # 保证跨视频的内容一致性（「我是谁、什么调性、绝不做什么」）
    channel_persona: str = ""
    # 成本报表币种（v0.14.1）：单价表以 USD 计，报表按汇率换算显示
    cost_currency: str = "CNY"  # CNY | USD
    cost_usd_rate: float = 7.2  # USD → cost_currency 汇率
    # 月度预算（v0.17，Helicone 阶梯告警借鉴）：0=不启用；按自然月累计
    # ai_calls 花费（当前单价动态计价），达阈值在 Dashboard/成本页提示（不阻断）
    cost_monthly_budget: float = 0.0  # 报表币种计

    @property
    def runtime_config_path(self) -> Path:
        return self.data_dir / "runtime.yaml"


class RuntimeConfig:
    """Runtime overrides stored in data/runtime.yaml.

    Layered on top of Settings at read time (AXIOM §22.3); written by the
    config UI. Never holds secrets (AXIOM §8.2). Cached by file mtime so
    attribute reads stay cheap.
    """

    def __init__(self, path: Path | None = None) -> None:
        self._path = path or settings_base.runtime_config_path
        self._cached: dict | None = None
        self._cached_mtime: float | None = None

    def load(self) -> dict:
        if not self._path.exists():
            self._cached = None
            self._cached_mtime = None
            return {}
        try:
            mtime = self._path.stat().st_mtime
        except OSError:
            return {}
        if self._cached is not None and mtime == self._cached_mtime:
            return self._cached
        try:
            data = yaml.safe_load(self._path.read_text(encoding="utf-8"))
            self._cached = data if isinstance(data, dict) else {}
        except (OSError, yaml.YAMLError):
            self._cached = {}
        self._cached_mtime = mtime
        return self._cached

    def save(self, data: dict) -> None:
        # Atomic write (tmp + fsync + os.replace): a crash mid-write must not
        # leave a half-written runtime.yaml (AXIOM §17.11).
        self._path.parent.mkdir(parents=True, exist_ok=True)
        payload = yaml.safe_dump(data, allow_unicode=True)
        tmp = self._path.with_suffix(".yaml.tmp")
        with tmp.open("w", encoding="utf-8") as fh:
            fh.write(payload)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, self._path)
        self._cached = data
        try:
            self._cached_mtime = self._path.stat().st_mtime
        except OSError:
            self._cached_mtime = None

    def get(self, name: str, default=None):
        return self.load().get(name, default)


settings_base = Settings()
runtime_config = RuntimeConfig()


class _EffectiveSettings:
    """Read-through proxy: runtime.yaml overrides shadow Settings (AXIOM §22.3).

    Services keep reading ``settings.xxx``; user-modified values from the
    config UI now actually take effect at read time.
    """

    _MISSING = object()
    # runtime.yaml 只能存字符串；这些字段在 Settings 中是 Path，读回需转换
    _PATH_FIELDS = ("data_dir", "output_dir", "log_dir", "assets_root")

    def __getattr__(self, name: str):
        if name.startswith("__"):
            raise AttributeError(name)
        value = runtime_config.get(name, self._MISSING)
        if value is not self._MISSING:
            if name in self._PATH_FIELDS and value is not None:
                return Path(value)
            return value
        return getattr(settings_base, name)


settings: Settings = _EffectiveSettings()  # type: ignore[assignment]
