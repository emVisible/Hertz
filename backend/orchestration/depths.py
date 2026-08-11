"""深度档位服务（v0.3.10）：输出深度可维护化——并列于 buff/debuff 的库。

内置五档以代码为准（_seed 同步）：新增的插入，已有的 builtin 行同步更新
name/effect（扩写升级立即生效）；用户自定义档位不受影响。
engine 运行时按档位 key 解析指令注入 system prompt（DB 优先，常量兜底）。
"""

import logging

from sqlalchemy import select

from backend.models.buff import DepthLevel
from backend.models.session import session_factory
from backend.orchestration.crud import BaseCrudService

logger = logging.getLogger(__name__)

# 内置五档单一真相源：极简 → 简洁 → 正常 → 详细 → 深挖
BUILTIN_DEPTHS: list[dict] = [
    {
        "key": "terse",
        "name": "极简",
        "effect": (
            "【输出深度·极简】只给结论，1–3 句话说完。不要小标题、不要分点、"
            "不要铺垫，直接给最核心的判断。"
        ),
    },
    {
        "key": "concise",
        "name": "简洁",
        "effect": (
            "【输出深度·简洁】短而有力：每个要点不超过 3 行，删除一切废话、"
            "客套与重复，直接给干货。"
        ),
    },
    {
        "key": "normal",
        "name": "正常",
        "effect": "",  # 默认档：不注入任何指令
    },
    {
        "key": "detailed",
        "name": "详细",
        "effect": (
            "【输出深度·详细】结构化展开：使用分点、分级小标题，必要时用表格，"
            "把每个论点讲透，论据充分、层次清楚。\n"
            "【反 AI 自查】展开越详细越容易 AI 腔：禁止'值得注意的是''总而言之'等套话，"
            "禁止'不仅是…更是…'排比，禁止每段破折号，具体数据/例子必须真实。"
        ),
    },
    {
        "key": "deep",
        "name": "深挖",
        "effect": (
            "【输出深度·深挖】深度调研模式：围绕主题主动展开垂直领域层面的挖掘——"
            "背景脉络、关键概念、数据与来源、不同角度的观点、可执行的结论；"
            "篇幅可以长，但必须言之有物，禁止空洞泛谈。\n"
            "【反 AI 自查】深挖模式最容易'意义膨胀'：禁止把普通事实拔高成'关键转折''"
            "深远影响'，禁止'专家认为'式无主归因，数据必须给出处，"
            "禁止'未来可期''值得期待'式空展望结尾。"
        ),
    },
]


class DepthService(BaseCrudService):
    model = DepthLevel

    async def _seed(self) -> None:
        """种入内置档位并同步代码版本（AXIOM §1.2 单一真相源）。"""
        async with session_factory() as session:
            rows = (await session.execute(select(DepthLevel))).scalars().all()
            by_key = {r.key: r for r in rows}
            changed = 0
            for i, depth in enumerate(BUILTIN_DEPTHS):
                row = by_key.get(depth["key"])
                if row is None:
                    session.add(
                        DepthLevel(
                            key=depth["key"],
                            name=depth["name"],
                            effect=depth["effect"],
                            builtin=True,
                            sort_order=i,
                        )
                    )
                    changed += 1
                elif row.builtin and (
                    row.name != depth["name"]
                    or row.effect != depth["effect"]
                    or row.sort_order != i
                ):
                    row.name = depth["name"]
                    row.effect = depth["effect"]
                    row.sort_order = i
                    changed += 1
            if changed:
                await session.commit()
                logger.info("synced %d builtin depth level(s)", changed)

    async def list_levels(self) -> list[dict]:
        """全部档位（enabled 优先 + sort_order 排序）。"""
        await self._seed()
        async with session_factory() as session:
            rows = (
                await session.execute(
                    select(DepthLevel)
                    .order_by(DepthLevel.enabled.desc(), DepthLevel.sort_order.asc())
                )
            ).scalars().all()
            return [await self._serialize(r) for r in rows]

    async def effect_for(self, key: str) -> str:
        """档位指令（DB 优先；内置兜底代码常量——无 DB/未 seed 时不阻塞运行）。"""
        await self._seed()
        async with session_factory() as session:
            row = (
                await session.execute(
                    select(DepthLevel).where(DepthLevel.key == key)
                )
            ).scalar_one_or_none()
            if row is not None and row.enabled:
                return row.effect
        for depth in BUILTIN_DEPTHS:
            if depth["key"] == key:
                return depth["effect"]
        return ""

    async def create(self, *, key: str, name: str, effect: str) -> dict:
        async with session_factory() as session:
            exists = (
                await session.execute(
                    select(DepthLevel).where(DepthLevel.key == key)
                )
            ).scalar_one_or_none()
            if exists is not None:
                raise ValueError(f"depth key already exists: {key}")
            row = DepthLevel(key=key, name=name, effect=effect)
            session.add(row)
            await session.commit()
            await session.refresh(row)
            return await self._serialize(row)

    async def restore_defaults(self) -> dict:
        """恢复出厂：删除全部行后重新 seed 内置五档（用户自定义一并清掉）。"""
        async with session_factory() as session:
            rows = (await session.execute(select(DepthLevel))).scalars().all()
            for row in rows:
                await session.delete(row)
            await session.commit()
        await self._seed()
        return {"ok": True, "count": len(BUILTIN_DEPTHS)}

    @staticmethod
    async def _serialize(row: DepthLevel) -> dict:
        return {
            "id": str(row.id),
            "key": row.key,
            "name": row.name,
            "effect": row.effect,
            "enabled": row.enabled,
            "builtin": row.builtin,
            "sort_order": row.sort_order,
        }
