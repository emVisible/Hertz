"""调用链与用量记录（v2.3）：每次 AI 调用写入 ai_calls 表。

- 由 TaskRouter 调用（尽力而为，失败不阻塞主流程）
- 查询入口：/api/ai/trace?task_id= 与 /api/ai/usage
"""

from backend.models.ai_registry import AICall
from backend.models.session import session_factory


async def record_call(
    *,
    task_id: str | None,
    caller: str,
    provider_key: str,
    model_key: str,
    role: str,
    operation: str,
    duration_ms: int,
    status: str = "ok",
    error: str | None = None,
    prompt_tokens: int | None = None,
    completion_tokens: int | None = None,
    cost_estimate: float | None = None,
    result_summary: str | None = None,
) -> None:
    async with session_factory() as session:
        session.add(
            AICall(
                task_id=task_id,
                caller=caller,
                provider_key=provider_key,
                model_key=model_key,
                role=role,
                operation=operation,
                duration_ms=duration_ms,
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                cost_estimate=cost_estimate,
                status=status,
                error=(error or "")[:2000],
                result_summary=(result_summary or "")[:300] or None,
            )
        )
        await session.commit()


async def list_calls(task_id: str | None = None, limit: int = 50) -> list[dict]:
    from sqlalchemy import select

    async with session_factory() as session:
        stmt = select(AICall).order_by(AICall.created_at.desc()).limit(min(limit, 200))
        if task_id:
            stmt = stmt.where(AICall.task_id == task_id)
        rows = (await session.execute(stmt)).scalars().all()
        return [
            {
                "id": str(r.id),
                "task_id": r.task_id,
                "caller": r.caller,
                "provider_key": r.provider_key,
                "model_key": r.model_key,
                "role": r.role,
                "operation": r.operation,
                "duration_ms": r.duration_ms,
                "status": r.status,
                "error": r.error,
                "result_summary": r.result_summary,
                # v0.5 E 成本估算：usage（无 usage 的 provider 为 None）
                "prompt_tokens": r.prompt_tokens,
                "completion_tokens": r.completion_tokens,
                "created_at": r.created_at.isoformat() if r.created_at else None,
            }
            for r in rows
        ]
