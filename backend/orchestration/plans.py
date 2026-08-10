"""PlanService — plan (template) CRUD with phase-order validation."""

from uuid import UUID

from backend.models.plan import Plan, PlanMode
from backend.orchestration.crud import BaseCrudService
from backend.orchestration.errors import InvalidPlanError, NotFoundError
from backend.orchestration.phases import (
    DEFAULT_PHASE_ORDER,
    LEGACY_PHASE_ALIASES,
    PHASE_INDEX,
)


class PlanService(BaseCrudService):
    model = Plan

    @staticmethod
    def _resolve_key(key: str) -> str | None:
        """把历史/未知 key 归一到现行工序；空别名表示"删除该工序"。"""
        if key in PHASE_INDEX:
            return key
        return LEGACY_PHASE_ALIASES.get(key) or None

    @classmethod
    def validate_phase_order(cls, phase_order: list | None) -> list | None:
        if phase_order is None:
            return phase_order
        if not isinstance(phase_order, list) or not phase_order:
            raise InvalidPlanError("phase_order must be a non-empty list")
        seen: set[str] = set()
        # 记录哪些 key 是通过历史别名折叠进来的：与显式 key 撞车时，
        # 保留显式项、丢弃别名项（旧计划 preflight+build_brief 并存是正常的）
        via_alias: set[str] = set()
        cleaned: list[dict] = []
        for item in phase_order:
            if not isinstance(item, dict):
                raise InvalidPlanError("each phase entry must be an object")
            raw_key = item.get("key", "")
            key = cls._resolve_key(raw_key)
            if key is None:
                # 旧工序（scout/analyst）在别名表中映射为空：跳过而非拒绝；
                # 完全未知的 key 才拒绝，保证旧计划能平滑保存
                if raw_key in LEGACY_PHASE_ALIASES:
                    continue
                raise InvalidPlanError(f"unknown phase key '{raw_key}'")
            if key in seen:
                # 显式重复仍然拒绝；别名折叠/别名与显式撞车则去重
                if raw_key == key and key not in via_alias:
                    raise InvalidPlanError(f"duplicate phase key '{key}'")
                continue
            seen.add(key)
            if raw_key != key:
                via_alias.add(key)
            cleaned.append(
                {
                    "key": key,
                    "enabled": bool(item.get("enabled", True)),
                    "config": item.get("config") or {},
                }
            )
        if not cleaned:
            raise InvalidPlanError("phase_order must be a non-empty list")
        return cleaned

    async def create(
        self,
        name: str,
        phase_order: list | None = None,
        mode: str = PlanMode.TEXT,
        crew_id: UUID | None = None,
        brief_id: UUID | None = None,
        description: str = "",
        buff_keys: list | None = None,
    ) -> dict:
        phase_order = self.validate_phase_order(phase_order) or DEFAULT_PHASE_ORDER
        return await super().create(
            name=name,
            mode=mode,
            phase_order=phase_order,
            crew_id=crew_id,
            brief_id=brief_id,
            description=description,
            buff_keys=buff_keys or [],
        )

    async def update(self, plan_id, **fields) -> dict:
        if "phase_order" in fields and fields["phase_order"] is not None:
            fields["phase_order"] = self.validate_phase_order(fields["phase_order"])
        return await super().update(plan_id, fields)

    async def clone(self, plan_id: UUID, name: str | None = None) -> dict:
        """克隆计划（v0.4 D2）：复制全部字段为新计划，独立可编辑。"""
        plan = await self._load(plan_id)
        if plan is None:
            raise NotFoundError()
        suffix = name or f"{plan.name} (副本)"
        return await self.create(
            name=suffix,
            description=plan.description or "",
            mode=plan.mode,
            phase_order=plan.phase_order,
            crew_id=plan.crew_id,
            brief_id=plan.brief_id,
            buff_keys=plan.buff_keys or [],
        )

    async def export(self, plan_id: UUID) -> dict:
        """导出计划（v0.4 D2）：JSON 快照（含依赖引用 id/keys，导入端校验）。"""
        plan = await self._load(plan_id)
        if plan is None:
            raise NotFoundError()
        return {
            "version": 1,
            "plan": self._serialize(plan),
        }

    async def import_plan(self, payload: dict) -> dict:
        """导入计划（v0.4 D2）：JSON 快照 → 新计划。

        依赖（crew/brief）引用 id 不存在时置空（导入端提示手动重挂）。
        """
        data = (payload or {}).get("plan") or payload
        if not isinstance(data, dict) or not data.get("name"):
            raise InvalidPlanError("plan payload missing name")
        try:
            phase_order = self.validate_phase_order(data.get("phase_order"))
        except InvalidPlanError:
            phase_order = DEFAULT_PHASE_ORDER
        return await self.create(
            name=str(data["name"]),
            description=str(data.get("description") or ""),
            mode=str(data.get("mode") or PlanMode.TEXT),
            phase_order=phase_order,
            crew_id=None,  # 跨环境 id 不可用：导入后手动重挂
            brief_id=None,
            buff_keys=list(data.get("buff_keys") or []),
        )

    @staticmethod
    def _serialize(plan: Plan) -> dict:
        return {
            "id": str(plan.id),
            "name": plan.name,
            "description": plan.description,
            "mode": plan.mode,
            # 读取时归一化历史 key（growth_director → distribution），
            # 旧计划在 UI 里直接显示新工序名
            "phase_order": PlanService.validate_phase_order(plan.phase_order) or [],
            "crew_id": str(plan.crew_id) if plan.crew_id else None,
            "brief_id": str(plan.brief_id) if plan.brief_id else None,
            "buff_keys": plan.buff_keys or [],
            "created_at": plan.created_at.isoformat() if plan.created_at else None,
            "updated_at": plan.updated_at.isoformat() if plan.updated_at else None,
        }
