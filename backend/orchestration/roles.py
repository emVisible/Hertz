"""RoleService — 角色库 CRUD（v4.1 简化）。

角色 = 内容型实体：key/name/role_name + MD description。
执行配置（method/style/model/timeout/retries）归工序库，角色不持有。
"""

import logging
from uuid import UUID

from sqlalchemy import select

from backend.models.role import Role
from backend.models.session import session_factory
from backend.orchestration.phases import PHASES

logger = logging.getLogger(__name__)

# 内置独立角色（v0.7）：不进 PHASES 的专职角色，seed 进角色库
BUILTIN_ROLES: list[dict] = [
    {
        "key": "ai_harmonizer",
        "name": "ai_harmonizer",
        "role_name": "AI 调和工程师",
        "description": (
            "# AI 调和工程师\n\n"
            "识别文本中的 AI 生成痕迹，把「机写」与「人写」调和成自然的人味输出——"
            "依据 Wikipedia:Signs of AI writing 与 WikiProject AI Cleanup 指南"
            "（33 模式 + no-fabrication 铁律 + stop-slop 五维自检）。\n\n"
            "## 人设\n\n"
            "你不反感 AI 文本，你反感 AI 腔。你的工作不是「消毒」，是「还原」："
            "把被统计均值抹平的具体性找回来，把被话术包裹的直白放出来。"
            "你像校对，但比校对多一层嗅觉——闻得出哪里在「装重要」。\n\n"
            "## 方法论\n\n"
            "### 1. 闻味（识别）\n"
            "- 词汇密度：delve/underscore/showcase/深耕/彰显/赋能/值得一提 成堆出现 → AI\n"
            "- 句式指纹：serves as 代替 is、不只是X更是Y、三法则排比、破折号成瘾\n"
            "- 内容膨胀：意义拔高（标志着/影响深远）、推销腔（风景如画/独特魅力）、\n"
            "  模糊归因（专家认为）、挑战公式（尽管…仍…+未来可期）\n"
            "- 机器残留：对话尾巴（希望这有帮助）、免责（根据现有资料）、\n"
            "  占位符（2025-xx-xx）、emoji 标题、加粗泛滥\n\n"
            "### 2. 调和（改写）\n"
            "- 一层层来：先删词，再改句，再砍内容，最后扫痕迹\n"
            "- 每处改写给出理由：这句为什么像 AI、改成什么、为什么像人\n"
            "- 保持原文信息量：只删空泛，不删事实\n\n"
            "### 3. 校准（人类质感）\n"
            "- 简单 is/has 句；具体动词（写=写）；允许「很/可能/比较」\n"
            "- 敢用绝对化（最好的之一/第一个）；重复同一个词而不是换花\n"
            "- 句子长短错落，像人说话，不像报告\n\n"
            "## 铁律\n\n"
            "不得编造：不添加源文本没有的事实、名字、日期、来源。"
            "具体性只能来自原文或作者本人。\n\n"
            "## 自检\n\n"
            "交付前五维评分（stop-slop）：直接/节奏/信任/真实/密度，"
            "任一低于 3/5 重写该段。最终标准：像一个人认真打字，不像一份报告。"
        ),
    },
]


class RoleService:
    async def _seed(self) -> None:
        """首次访问：种入默认角色 + 内置专职角色（幂等，已存在跳过）。"""
        async with session_factory() as session:
            existing = set((await session.execute(select(Role.key))).scalars().all())
            agents = [p for p in PHASES if p.phase_type == "agent"]
            missing = [a for a in agents if a.key not in existing]
            for i, agent in enumerate(missing):
                parts = [f"# {agent.role or agent.name}"]
                if agent.method:
                    parts.append(f"## 方法论\n\n{agent.method}")
                if agent.style:
                    parts.append(f"## 风格\n\n{', '.join(agent.style)}")
                session.add(
                    Role(
                        key=agent.key,
                        name=agent.key,
                        role_name=agent.role or agent.name,
                        description="\n\n".join(parts),
                        sort_order=i,
                    )
                )
            for i, role in enumerate(BUILTIN_ROLES):
                if role["key"] in existing:
                    continue
                session.add(
                    Role(
                        key=role["key"],
                        name=role["name"],
                        role_name=role["role_name"],
                        description=role["description"],
                        sort_order=100 + i,
                    )
                )
                existing.add(role["key"])
            await session.commit()
            logger.info("seeded %d default role(s)", len(missing))

    async def list_roles(self) -> list[dict]:
        await self._seed()
        async with session_factory() as session:
            rows = (
                (await session.execute(
                    select(Role).order_by(Role.sort_order, Role.created_at)
                )).scalars().all()
            )
            return [self._serialize(r) for r in rows]

    async def get(self, role_id: UUID) -> dict:
        async with session_factory() as session:
            row = await session.get(Role, role_id)
            if row is None:
                raise KeyError(f"role not found: {role_id}")
            return self._serialize(row)

    async def create(
        self,
        *,
        key: str,
        name: str,
        role_name: str = "",
        description: str = "",
    ) -> dict:
        async with session_factory() as session:
            exists = (await session.execute(
                select(Role).where(Role.key == key)
            )).scalar_one_or_none()
            if exists is not None:
                raise ValueError(f"role key already exists: {key}")
            row = Role(
                key=key,
                name=name.strip(),
                role_name=role_name.strip() or name.strip(),
                description=description,
            )
            session.add(row)
            await session.commit()
            await session.refresh(row)
            return self._serialize(row)

    async def update(self, role_id: UUID, **fields) -> dict:
        async with session_factory() as session:
            row = await session.get(Role, role_id)
            if row is None:
                raise KeyError(f"role not found: {role_id}")
            for key, value in fields.items():
                if value is not None and hasattr(row, key):
                    setattr(row, key, value)
            await session.commit()
            await session.refresh(row)
            return self._serialize(row)

    async def delete(self, role_id: UUID) -> None:
        async with session_factory() as session:
            row = await session.get(Role, role_id)
            if row is None:
                raise KeyError(f"role not found: {role_id}")
            await session.delete(row)
            await session.commit()

    @staticmethod
    def _serialize(row: Role) -> dict:
        return {
            "id": str(row.id),
            "key": row.key,
            "name": row.name,
            "role_name": row.role_name,
            "description": row.description,
            "enabled": row.enabled,
            "sort_order": row.sort_order,
            "created_at": row.created_at.isoformat() if row.created_at else None,
            "updated_at": row.updated_at.isoformat() if row.updated_at else None,
        }
