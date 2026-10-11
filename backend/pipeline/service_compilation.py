"""多素材合集编排域（v0.35）——建合集条目 / 改编排 / 拆解。

与「生产方式」域（`service_review.set_produce_options`）分开：那是五个模块开关、
可批量套用；这里是片段列表 + 顺序 + 转场，逐条精细编排。两者生命周期不同，
混在一个写点里会被批量操作互相覆盖。

产物形态是**新建一条合集条目**（`status=downloaded`、`raw_path=None`、`clips={...}`），
原素材条目**完全不动**——它们仍留在「已下载未加工」里，可以被别的合集再次引用，
也可以单独发。代价是同一条素材可能被多条合集引用（成品里出现两次），
这是用户显式编排的结果，不在服务端替他裁剪。
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime

from sqlalchemy import select

from backend.infrastructure.storage import next_output_slug
from backend.models.item import Item, ItemStatus
from backend.models.session import session_factory
from backend.pipeline.errors import ItemNotFoundError
from backend.pipeline.producers.assemble import (
    MAX_TRANSITION_S,
    MIN_TRANSITION_S,
    TRANSITION_CHOICES,
)

logger = logging.getLogger(__name__)

#: 单条合集的片段上限。filter_complex 随片段数线性膨胀，且总时长也随之线性增长
#: （平台侧时长上限另由界面警告）。这是服务端**硬**上限——前端再怎么说也要拦。
MAX_CLIPS = 30


def normalize_clip_plan(
    clips: list[dict] | None,
    outro: dict | None = None,
) -> dict:
    """把请求体规范化成落库形状，顺带做**结构性**校验。

    校验在这一层（而不是只靠 pydantic）的原因：片段是嵌套结构，
    「同一素材被引用两次」「自引用」「引用不存在」这些规则都需要查库，
    放不进纯 schema。这里抛 ValueError，由 router 映射 422——
    与 `set_produce_options` / `set_priority` 同一套纪律。
    """
    if not clips:
        raise ValueError("合集至少需要 1 个片段")
    if len(clips) > MAX_CLIPS:
        raise ValueError(f"单条合集最多 {MAX_CLIPS} 个片段（当前 {len(clips)}）")

    seen: set[str] = set()
    normalized: list[dict] = []
    for index, raw in enumerate(clips):
        if not isinstance(raw, dict):
            raise ValueError(f"第 {index + 1} 个片段格式非法")
        try:
            item_id = str(uuid.UUID(str(raw.get("item_id"))))
        except (ValueError, AttributeError, TypeError):
            raise ValueError(f"第 {index + 1} 个片段缺少合法 item_id") from None
        if item_id in seen:
            raise ValueError(
                f"第 {index + 1} 个片段与前面的片段重复引用了同一条素材"
                "（同一条素材在一条合集里出现两次会让成片出现重复画面）"
            )
        seen.add(item_id)
        entry: dict = {"item_id": item_id}
        # 第一段没有「入场转场」可言——显式落成 cut，别让下游猜
        transition = raw.get("transition") or "cut"
        if transition not in TRANSITION_CHOICES:
            raise ValueError(
                f"第 {index + 1} 个片段的转场 '{transition}' 不支持"
                f"（可选：{list(TRANSITION_CHOICES)}）"
            )
        entry["transition"] = "cut" if index == 0 else transition
        seconds = raw.get("transition_s")
        if seconds is not None:
            try:
                value = float(seconds)
            except (TypeError, ValueError):
                raise ValueError(
                    f"第 {index + 1} 个片段的转场时长非法：{seconds}"
                ) from None
            if not (MIN_TRANSITION_S <= value <= MAX_TRANSITION_S):
                raise ValueError(
                    f"第 {index + 1} 个片段的转场时长须在 "
                    f"{MIN_TRANSITION_S}–{MAX_TRANSITION_S} 秒之间（当前 {value}）"
                )
            entry["transition_s"] = value
        normalized.append(entry)

    plan: dict = {"clips": normalized}
    if outro and outro.get("enabled"):
        duration = float(outro.get("duration_s") or 2.5)
        if not (1.0 <= duration <= 10.0):
            raise ValueError(f"片尾时长须在 1–10 秒之间（当前 {duration}）")
        plan["outro"] = {
            "enabled": True,
            "duration_s": duration,
            "subtitle": str(outro.get("subtitle") or "").strip()[:60],
        }
    return plan


class CompilationOpsMixin:
    """合集编排域（v0.35）。"""

    async def create_compilation(
        self,
        clip_ids: list[uuid.UUID],
        *,
        title: str = "",
        clips: list[dict] | None = None,
        outro: dict | None = None,
        channel_key: str | None = None,
        produce_options: dict | None = None,
    ) -> dict:
        """新建一条合集条目（status=downloaded，直接可制作）。

        只引用、不复制、不改动任何源条目——它们的 status/raw_path/产物一律不碰。
        """
        # 编排形状以 `clips`（带转场）为准；只给了 clip_ids 时按顺序裸拼。
        if clips is None:
            clips = [{"item_id": str(cid)} for cid in clip_ids]
        elif clip_ids:
            # 两条入口同时给 → 以 clips 的顺序为准，clip_ids 仅作去重兜底
            plan_ids = {str(c.get("item_id")) for c in clips if isinstance(c, dict)}
            extra = [str(cid) for cid in clip_ids if str(cid) not in plan_ids]
            clips = list(clips) + [{"item_id": i} for i in extra]
        plan = normalize_clip_plan(clips, outro)

        async with session_factory() as session:
            source_ids = [c["item_id"] for c in plan["clips"]]
            rows = (
                await session.execute(select(Item).where(Item.id.in_(source_ids)))
            ).scalars().all()
            found = {str(r.id): r for r in rows}
            missing = [i for i in source_ids if i not in found]
            if missing:
                raise ValueError(f"片段不存在：{', '.join(missing[:3])}")

            # 结构性前置校验：源必须已下载且有 raw——否则合集条目建出来却拼不出来
            for entry in plan["clips"]:
                row = found[entry["item_id"]]
                if row.status != ItemStatus.DOWNLOADED:
                    raise ValueError(
                        f"片段「{row.title[:30]}」当前状态是 {row.status}，"
                        "只有已下载未加工的条目才能作为片段"
                    )
                if not row.raw_path:
                    raise ValueError(f"片段「{row.title[:30]}」没有原始媒体文件")

            # 防自引用：把已有合集条目再塞进另一个合集会让产物递归嵌套
            for entry in plan["clips"]:
                if found[entry["item_id"]].clips:
                    raise ValueError("片段本身是合集条目，不能再被嵌套进合集")

            from pathlib import Path

            from backend.config import settings

            root = Path(settings.data_dir) / "pipeline"
            slug = next_output_slug(root)

            label = (title or "").strip()[:80]
            if not label:
                first = found[plan["clips"][0]["item_id"]]
                label = f"{first.title[:40]} 等 {len(plan['clips'])} 段合集"

            item = Item(
                status=ItemStatus.DOWNLOADED,
                item_type="video_raw",
                source="compilation",
                source_id=f"compilation:{uuid.uuid4().hex[:12]}",
                title=label,
                output_dir=f"pipeline/{slug}",
                clips=plan,
                raw_path=None,  # 合集没有原始媒体：产物由装配生成
                channel_key=channel_key,
                # 合集默认走「直发」语义：已经拼好的成片不需要再加工一遍，
                # 与 DEFAULT_PRODUCE_OPTIONS（v0.11.9）保持一致
                produce_options=produce_options or {"passthrough": True},
                selftext=None,
            )
            session.add(item)
            await session.commit()
            await session.refresh(item)
            logger.info(
                "compilation created: %d clips → item %s", len(plan["clips"]), item.id
            )
            return {
                "id": str(item.id),
                "title": item.title,
                "status": item.status,
                "clips": item.clips,
                "output_dir": item.output_dir,
                "created_at": datetime.now(UTC).isoformat(),
            }

    async def update_compilation(
        self, item_id: uuid.UUID, *, clips: list[dict], outro: dict | None = None,
    ) -> dict:
        """改已有合集的编排（拖拽排序 / 调转场）。片段数与引用同样校验。"""
        plan = normalize_clip_plan(clips, outro)
        async with session_factory() as session:
            item = await session.get(Item, item_id)
            if item is None:
                raise ItemNotFoundError(item_id)
            if not item.clips:
                raise ValueError("该条目不是合集")
            source_ids = [c["item_id"] for c in plan["clips"]]
            rows = (
                await session.execute(select(Item).where(Item.id.in_(source_ids)))
            ).scalars().all()
            found = {str(r.id): r for r in rows}
            for entry in plan["clips"]:
                row = found.get(entry["item_id"])
                if row is None:
                    raise ValueError(f"片段不存在：{entry['item_id']}")
                if row.status != ItemStatus.DOWNLOADED or not row.raw_path:
                    raise ValueError(
                        f"片段「{row.title[:30]}」不可用（需已下载且有原始媒体）"
                    )
                if row.clips:
                    raise ValueError("片段本身是合集条目，不能再被嵌套进合集")
            item.clips = plan
            await session.commit()
            return {"id": str(item.id), "clips": item.clips}

    async def compilation_sources(self) -> list[dict]:
        """可作为片段的条目（已下载、有 raw、非合集、非隔离非归档）。

        编排面板的选择器用这个列表——把「能不能当片段」的判据收在服务端一处，
        免得前端再写一遍状态判断、两边漂移。
        """
        async with session_factory() as session:
            rows = (
                await session.execute(
                    select(Item)
                    .where(
                        Item.status == ItemStatus.DOWNLOADED,
                        Item.raw_path.isnot(None),
                        Item.clips.is_(None),
                        Item.is_invalid.is_(False),
                        Item.archived.is_(False),
                    )
                    .order_by(Item.seq.desc().nulls_last())
                    .limit(500)
                )
            ).scalars().all()
            return [
                {
                    "id": str(r.id),
                    "title": r.title,
                    "item_type": r.item_type,
                    "raw_path": r.raw_path,
                    "cover_path": r.cover_path,
                    "duration_s": None,  # 前端从 items 列表已有的信息拿，或留空
                }
                for r in rows
            ]
