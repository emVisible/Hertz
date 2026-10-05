"""Execution-domain model: per-source collection state.

The JobRun audit trail lives in backend.models.system (job_runs table).
"""

import json
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Float, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from backend.models.base import BaseModel


class SourceState(BaseModel):
    """Per-(source, channel) cursor and failure bookkeeping.

    Cursor enables incremental collection (only fetch NEW posts since the
    last run); cooldowns back off failing endpoints. UNIQUE on (source, channel).
    """

    __tablename__ = "source_state"
    __table_args__ = (UniqueConstraint("source", "channel"),)

    source: Mapped[str] = mapped_column(String(64), index=True)
    channel: Mapped[str] = mapped_column(String(128), index=True)
    cursor_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    cooldowns_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    ok_count: Mapped[int] = mapped_column(Integer, default=0)
    fail_count: Mapped[int] = mapped_column(Integer, default=0)
    # 数据源健康度（v0.2.1，参考原项目）：连续失败 + 最后错误 → dead/degraded/healthy
    consecutive_fails: Mapped[int] = mapped_column(Integer, default=0)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    last_error_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_strategy: Mapped[str | None] = mapped_column(String(32), nullable=True)
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    @classmethod
    def for_source(cls, source: str, channel: str) -> "SourceState":
        """新建一条源状态，计数器显式归零（D-224）。

        `mapped_column(default=0)` 是 flush 时才写进 INSERT 的 Python 侧默认，
        刚 new 出来的实例读到的仍是 None；调用方紧接着 `state.fail_count += 1`
        就得到 `TypeError: NoneType + int`，而记账外层吞异常——于是每个**新数据源
        的第一次失败**悄悄无痕（冷却、连续失败、界面健康徽章全无）。
        """
        return cls(source=source, channel=channel, ok_count=0, fail_count=0, consecutive_fails=0)

    def get_cursor(self) -> dict:
        if not self.cursor_json:
            return {}
        try:
            data = json.loads(self.cursor_json)
            return data if isinstance(data, dict) else {}
        except ValueError:
            return {}

    def set_cursor(self, cursor: dict) -> None:
        self.cursor_json = json.dumps(cursor, ensure_ascii=False)

    def get_cooldowns(self) -> dict[str, float]:
        if not self.cooldowns_json:
            return {}
        try:
            data = json.loads(self.cooldowns_json)
            return {str(k): float(v) for k, v in data.items()} if isinstance(data, dict) else {}
        except (ValueError, TypeError):
            return {}

    def set_cooldowns(self, cooldowns: dict[str, float]) -> None:
        self.cooldowns_json = json.dumps(cooldowns)


class ResourceCooldown(BaseModel):
    """媒体资源冷却（v0.3.6 冰川式，参考原项目 CDN 熔断扩展）。

    采集失败冷却记在 SourceState；下载失败按**媒体域**冻结——期间跳过该域
    全部下载（条目保持 discovered 不 FAILED），避免反复打被封锁的 CDN。
    指数退避落库持久（重启不丢）；域内任一下载成功即解冻。
    """

    __tablename__ = "resource_cooldown"

    domain: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    fail_level: Mapped[int] = mapped_column(Integer, default=1)
    until_epoch: Mapped[float] = mapped_column(Float, default=0.0)


class ProduceTemplate(BaseModel):
    """生产方式预设模板（v0.4 B3）：命名组合一键套用批量生产方式。

    内置四模板以代码为准（seed 同步）；用户可增改自定义模板。
    options_json = 生产方式模块组合（passthrough/voice/subtitle/translate/mute）。
    """

    __tablename__ = "produce_templates"

    name: Mapped[str] = mapped_column(String(120))
    options_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    builtin: Mapped[bool] = mapped_column(Boolean, default=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)


class StylePreset(BaseModel):
    """风格预设（v0.26 创作资产）：命名栏目创意包，一处定义多处套用。

    config_json = 创意子集 {voice/bili_tid/desc_template/tags/
    title_style_prompt/persona_prompt/intro_config}——排除 name/source_pool/
    enabled（归属类字段不随预设走）。无内置，用户从栏目存为预设。
    """

    __tablename__ = "style_presets"

    name: Mapped[str] = mapped_column(String(120))
    config_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    builtin: Mapped[bool] = mapped_column(Boolean, default=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)


class ChannelInsight(BaseModel):
    """频道洞察快照（v0.19 数据飞轮一期）：历史保留，注入取最新。"""

    __tablename__ = "channel_insights"

    insights_json: Mapped[dict] = mapped_column(JSONB, nullable=False)
    source_count: Mapped[int] = mapped_column(default=0)
