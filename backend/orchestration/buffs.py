"""BuffService — Buff/Debuff 库 CRUD（v5.2）。

Buff = 注入 agent system prompt 的附加指令（态度/话术），两级：
lightweight（轻量纯文本）/ heavy（重量，类 skill——复杂多段指令）。
Debuff = 反向提示词（指明"不要做什么"），与 buff 同一维护机制，
按 polarity 区分注入为【禁忌】段。
内置以代码为准（AXIOM §1.2 单一真相源）：_seed 时同步代码版本，
用户想自定义请新建（内置 key 会被代码覆盖）。random 特殊 key 从随机池抽取。
"""

import logging
import random
from uuid import UUID

from sqlalchemy import select

from backend.models.buff import Buff
from backend.models.session import session_factory
from backend.orchestration.buffs_data import BUILTIN_BUFFS, BUILTIN_DEBUFFS, RANDOM_BUFFS

logger = logging.getLogger(__name__)

# 内置 debuff 单一真相源：反向提示词（"不要做什么"）
class BuffService:
    async def _seed(self) -> None:
        """种入内置 buff/debuff 并同步代码版本（AXIOM §1.2 单一真相源）。

        内置以代码为准：新增的插入，已有的 builtin 行同步更新
        name/kind/polarity/effect/category（扩写升级立即生效）；用户自定义不受影响。
        """
        async with session_factory() as session:
            rows = (await session.execute(select(Buff))).scalars().all()
            by_key = {r.key: r for r in rows}
            changed = 0
            all_builtins = [*BUILTIN_BUFFS, *RANDOM_BUFFS, *BUILTIN_DEBUFFS]
            for i, buff in enumerate(all_builtins):
                row = by_key.get(buff["key"])
                polarity = buff.get("polarity", "buff")
                if row is None:
                    session.add(
                        Buff(
                            key=buff["key"],
                            name=buff["name"],
                            kind=buff.get("kind", "lightweight"),
                            effect=buff["effect"],
                            category=buff.get("category", "stable"),
                            polarity=polarity,
                            builtin=True,
                            sort_order=i,
                        )
                    )
                    changed += 1
                elif row.builtin and (
                    row.name != buff["name"]
                    or row.effect != buff["effect"]
                    or row.kind != buff.get("kind", "lightweight")
                    or row.category != buff.get("category", "stable")
                    or row.polarity != polarity
                ):
                    row.name = buff["name"]
                    row.effect = buff["effect"]
                    row.kind = buff.get("kind", "lightweight")
                    row.category = buff.get("category", "stable")
                    row.polarity = polarity
                    changed += 1
            if changed:
                await session.commit()
                logger.info("synced %d builtin buff(s)", changed)

    async def list_buffs(self) -> list[dict]:
        await self._seed()
        async with session_factory() as session:
            rows = (
                (await session.execute(
                    select(Buff).order_by(Buff.category, Buff.sort_order, Buff.created_at)
                )).scalars().all()
            )
            return [self._serialize(r) for r in rows]

    async def get(self, buff_id: UUID) -> dict:
        async with session_factory() as session:
            row = await session.get(Buff, buff_id)
            if row is None:
                raise KeyError(f"buff not found: {buff_id}")
            return self._serialize(row)

    async def create(
        self,
        *,
        key: str,
        name: str,
        kind: str = "lightweight",
        polarity: str = "buff",
        effect: str = "",
        category: str = "stable",
    ) -> dict:
        async with session_factory() as session:
            exists = (await session.execute(
                select(Buff).where(Buff.key == key)
            )).scalar_one_or_none()
            if exists is not None:
                raise ValueError(f"buff key already exists: {key}")
            row = Buff(
                key=key,
                name=name.strip(),
                kind=kind,
                polarity=polarity,
                effect=effect,
                category=category,
            )
            session.add(row)
            await session.commit()
            await session.refresh(row)
            return self._serialize(row)

    async def update(self, buff_id: UUID, **fields) -> dict:
        async with session_factory() as session:
            row = await session.get(Buff, buff_id)
            if row is None:
                raise KeyError(f"buff not found: {buff_id}")
            for key, value in fields.items():
                if value is not None and hasattr(row, key):
                    setattr(row, key, value)
            await session.commit()
            await session.refresh(row)
            return self._serialize(row)

    async def delete(self, buff_id: UUID) -> None:
        async with session_factory() as session:
            row = await session.get(Buff, buff_id)
            if row is None:
                raise KeyError(f"buff not found: {buff_id}")
            await session.delete(row)
            await session.commit()

    # ---------- engine ----------

    async def resolve_effects(self, buff_keys: list[str]) -> list[dict]:
        """buff keys → 注入指令。`random`/`wild_card` 从随机池抽 2 个。

        返回 [{key, name, kind, effect}]——engine 拼进 system prompt。
        """
        await self._seed()
        if not buff_keys:
            return []
        resolved: list[dict] = []
        seen: set[str] = set()
        async with session_factory() as session:
            rows = (
                (await session.execute(
                    select(Buff).where(Buff.enabled.is_(True))
                )).scalars().all()
            )
            index = {r.key: r for r in rows}
        for key in buff_keys:
            if key in ("random", "wild_card"):
                # 从 random 池随机抽 3 个（每次运行不同——肉鸽感，至少 3 个）
                pool = [r for r in index.values() if r.category == "random"]
                picks = random.sample(pool, min(3, len(pool)))
                for p in picks:
                    if p.key in seen:
                        continue
                    seen.add(p.key)
                    resolved.append(self._serialize(p))
                continue
            row = index.get(key)
            if row and row.key not in seen:
                seen.add(row.key)
                resolved.append(self._serialize(row))
        return resolved

    @staticmethod
    def _serialize(row: Buff) -> dict:
        return {
            "id": str(row.id),
            "key": row.key,
            "name": row.name,
            "kind": row.kind,
            "polarity": row.polarity,
            "effect": row.effect,
            "category": row.category,
            "enabled": row.enabled,
            "builtin": row.builtin,
            "sort_order": row.sort_order,
            "created_at": row.created_at.isoformat() if row.created_at else None,
            "updated_at": row.updated_at.isoformat() if row.updated_at else None,
        }
