"""Monoline 融合域 DB 访问层（PG + SQLAlchemy，对应 monoline 原 `db/repo.py`）。

原 Repo 是 SQLite 直 SQL；此处按 Hertz 惯例经 `session_factory` 访问 ORM
（backend/models/monoline.py）。对外一律用 UUID，序列化为 dict（id 转 str）。
"""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import delete, func, select

from backend.models.monoline import (
    MonolineArtifact,
    MonolineBrand,
    MonolineEvent,
    MonolineJob,
    MonolineJobStage,
    MonolinePreset,
    MonolineScenePlan,
    MonolineSegment,
)
from backend.models.session import session_factory


def _now():
    return datetime.now(UTC)


def _job_dict(j: MonolineJob) -> dict:
    return {
        "id": str(j.id), "slug": j.slug, "title": j.title, "status": j.status,
        "script_text": j.script_text, "config": j.config, "canvas": j.canvas,
        "total_duration": j.total_duration, "hf_version": j.hf_version, "error": j.error,
        "created_at": j.created_at, "updated_at": j.updated_at,
        "started_at": j.started_at, "finished_at": j.finished_at,
    }


def _stage_dict(s: MonolineJobStage) -> dict:
    return {
        "job_id": str(s.job_id), "key": s.key, "seq": s.seq, "status": s.status,
        "input_hash": s.input_hash, "output_json": s.output_json, "attempts": s.attempts,
        "started_at": s.started_at, "finished_at": s.finished_at,
        "duration_ms": s.duration_ms, "error": s.error,
    }


def _seg_dict(s: MonolineSegment) -> dict:
    return {
        "i": s.i, "text": s.text, "line_no": s.line_no, "wav_path": s.wav_path,
        "wav_bytes": s.wav_bytes, "tts_duration": s.tts_duration,
        "start": s.start, "end": s.end, "norm_duration": s.norm_duration,
        "audio_source": s.audio_source, "voice": s.voice, "lang": s.lang, "speed": s.speed,
    }


class MonolineStore:
    """无状态，所有方法经短会话访问（调用方可单例复用）。"""

    # ---------- jobs ----------

    async def create_job(self, *, script_text: str, config: dict, canvas: dict,
                         title: str = "", slug: str = "") -> UUID:
        async with session_factory() as session:
            job = MonolineJob(script_text=script_text, config=config, canvas=canvas,
                              title=title, slug=slug)
            session.add(job)
            await session.commit()
            await session.refresh(job)
            return job.id

    async def get_job(self, job_id: UUID) -> dict | None:
        async with session_factory() as session:
            job = await session.get(MonolineJob, job_id)
            return _job_dict(job) if job else None

    async def update_job(self, job_id: UUID, **fields) -> None:
        if not fields:
            return
        async with session_factory() as session:
            job = await session.get(MonolineJob, job_id)
            if job is None:
                return
            for k, v in fields.items():
                if hasattr(job, k):
                    setattr(job, k, v)
            await session.commit()

    async def list_jobs(self, limit: int = 50) -> list[dict]:
        async with session_factory() as session:
            rows = (await session.execute(
                select(MonolineJob).order_by(MonolineJob.created_at.desc()).limit(limit)
            )).scalars().all()
            return [_job_dict(j) for j in rows]

    async def list_by_status(self, statuses: tuple[str, ...]) -> list[dict]:
        async with session_factory() as session:
            rows = (await session.execute(
                select(MonolineJob).where(MonolineJob.status.in_(statuses))
            )).scalars().all()
            return [_job_dict(j) for j in rows]

    async def delete_job(self, job_id: UUID) -> bool:
        async with session_factory() as session:
            job = await session.get(MonolineJob, job_id)
            if job is None:
                return False
            await session.delete(job)
            await session.commit()
            return True

    # ---------- stages ----------

    async def upsert_stage(self, job_id: UUID, key: str, seq: int, **fields) -> None:
        async with session_factory() as session:
            row = (await session.execute(
                select(MonolineJobStage).where(
                    MonolineJobStage.job_id == job_id, MonolineJobStage.key == key)
            )).scalar_one_or_none()
            if row is None:
                row = MonolineJobStage(job_id=job_id, key=key, seq=seq)
                session.add(row)
            for k, v in fields.items():
                if hasattr(row, k):
                    setattr(row, k, v)
            await session.commit()

    async def get_stage(self, job_id: UUID, key: str) -> dict | None:
        async with session_factory() as session:
            row = (await session.execute(
                select(MonolineJobStage).where(
                    MonolineJobStage.job_id == job_id, MonolineJobStage.key == key)
            )).scalar_one_or_none()
            return _stage_dict(row) if row else None

    async def list_stages(self, job_id: UUID) -> list[dict]:
        async with session_factory() as session:
            rows = (await session.execute(
                select(MonolineJobStage).where(MonolineJobStage.job_id == job_id)
                .order_by(MonolineJobStage.seq)
            )).scalars().all()
            return [_stage_dict(r) for r in rows]

    # ---------- segments ----------

    async def replace_segments(self, job_id: UUID, rows: list[dict]) -> None:
        # A1：重排时整行搬运（wav/时长/音色跟随节拍），故透传已知列；缺省走列默认值
        _cols = ("text", "line_no", "wav_path", "wav_bytes", "tts_duration", "start",
                 "end", "audio_source", "voice", "lang", "speed")
        async with session_factory() as session:
            await session.execute(delete(MonolineSegment).where(MonolineSegment.job_id == job_id))
            for r in rows:
                kwargs = {"job_id": job_id, "i": int(r["i"])}
                for c in _cols:
                    if r.get(c) is not None:
                        kwargs[c] = r[c]
                if "text" not in kwargs:
                    kwargs["text"] = ""
                session.add(MonolineSegment(**kwargs))
            await session.commit()

    async def get_segments(self, job_id: UUID) -> list[dict]:
        async with session_factory() as session:
            rows = (await session.execute(
                select(MonolineSegment).where(MonolineSegment.job_id == job_id)
                .order_by(MonolineSegment.i)
            )).scalars().all()
            return [_seg_dict(r) for r in rows]

    async def update_segment(self, job_id: UUID, i: int, **fields) -> None:
        async with session_factory() as session:
            row = (await session.execute(
                select(MonolineSegment).where(
                    MonolineSegment.job_id == job_id, MonolineSegment.i == i)
            )).scalar_one_or_none()
            if row is None:
                return
            for k, v in fields.items():
                if hasattr(row, k):
                    setattr(row, k, v)
            await session.commit()

    # ---------- plans ----------

    async def get_plan(self, job_id: UUID) -> dict | None:
        async with session_factory() as session:
            row = (await session.execute(
                select(MonolineScenePlan).where(MonolineScenePlan.job_id == job_id)
                .order_by(MonolineScenePlan.version.desc()).limit(1)
            )).scalar_one_or_none()
            if row is None:
                return None
            return {"version": row.version, "plan_json": row.plan_json,
                    "source": row.source, "warnings_json": row.warnings_json,
                    "created_at": row.created_at}

    async def save_plan(self, job_id: UUID, plan_json: str, source: str, warnings) -> int:
        import json as _json

        async with session_factory() as session:
            ver = (await session.execute(
                select(func.coalesce(func.max(MonolineScenePlan.version), 0)).where(
                    MonolineScenePlan.job_id == job_id)
            )).scalar_one() or 0
            row = MonolineScenePlan(
                job_id=job_id, version=int(ver) + 1,
                plan_json=_json.loads(plan_json) if isinstance(plan_json, str) else plan_json,
                source=source,
                warnings_json=warnings if isinstance(warnings, list) else None,
            )
            session.add(row)
            await session.commit()
            return row.version

    # ---------- artifacts ----------

    async def add_artifact(self, job_id: UUID, *, kind: str, stage_key: str | None = None,
                           rel_path: str | None = None, abs_path: str | None = None,
                           mime: str | None = None, size_bytes: int | None = None,
                           sha256: str | None = None, duration_seconds: float | None = None,
                           fps: int | None = None, width: int | None = None,
                           height: int | None = None) -> UUID:
        async with session_factory() as session:
            row = MonolineArtifact(
                job_id=job_id, kind=kind, stage_key=stage_key, rel_path=rel_path,
                abs_path=abs_path, mime=mime, size_bytes=size_bytes, sha256=sha256,
                duration_seconds=duration_seconds, fps=fps, width=width, height=height,
            )
            session.add(row)
            await session.commit()
            await session.refresh(row)
            return row.id

    async def list_artifacts(self, job_id: UUID) -> list[dict]:
        async with session_factory() as session:
            rows = (await session.execute(
                select(MonolineArtifact).where(MonolineArtifact.job_id == job_id)
                .order_by(MonolineArtifact.created_at)
            )).scalars().all()
            return [{"id": str(r.id), "kind": r.kind, "stage_key": r.stage_key,
                     "rel_path": r.rel_path, "mime": r.mime, "size_bytes": r.size_bytes,
                     "duration_seconds": r.duration_seconds, "fps": r.fps,
                     "width": r.width, "height": r.height, "state": r.state} for r in rows]

    # ---------- events ----------

    async def add_event(self, job_id: UUID, kind: str, *, stage_key: str | None = None,
                        level: str = "info", message: str | None = None,
                        data: dict | None = None) -> None:
        async with session_factory() as session:
            session.add(MonolineEvent(
                job_id=job_id, kind=kind, stage_key=stage_key, level=level,
                message=message, data_json=data,
            ))
            await session.commit()

    async def list_events(self, job_id: UUID, limit: int = 500) -> list[dict]:
        async with session_factory() as session:
            rows = (await session.execute(
                select(MonolineEvent).where(MonolineEvent.job_id == job_id)
                .order_by(MonolineEvent.ts).limit(limit)
            )).scalars().all()
            return [{"kind": r.kind, "stage_key": r.stage_key, "level": r.level,
                     "message": r.message, "data": r.data_json, "ts": r.ts} for r in rows]

    # ---------- presets ----------

    async def list_presets(self) -> list[dict]:
        async with session_factory() as session:
            rows = (await session.execute(select(MonolinePreset))).scalars().all()
            return [{"id": str(r.id), "name": r.name, "config": r.config} for r in rows]

    async def save_preset(self, name: str, config: dict) -> UUID:
        async with session_factory() as session:
            row = MonolinePreset(name=name, config=config)
            session.add(row)
            await session.commit()
            await session.refresh(row)
            return row.id

    async def delete_preset(self, preset_id: UUID) -> bool:
        async with session_factory() as session:
            row = await session.get(MonolinePreset, preset_id)
            if row is None:
                return False
            await session.delete(row)
            await session.commit()
            return True

    # ---------- brand（用户级默认外观，单行：取最新一行） ----------

    async def get_brand(self) -> dict:
        async with session_factory() as session:
            row = (await session.execute(
                select(MonolineBrand).order_by(MonolineBrand.updated_at.desc()).limit(1)
            )).scalar_one_or_none()
            if row is None:
                return {"label": "Monoline", "theme": "mono-ink",
                        "accent": None, "logo_name": None}
            return {"id": str(row.id), "label": row.label, "theme": row.theme,
                    "accent": row.accent, "logo_name": row.logo_name}

    async def save_brand(self, *, label: str | None = None, theme: str | None = None,
                         accent: str | None = None, logo_name: str | None = None) -> dict:
        async with session_factory() as session:
            row = (await session.execute(
                select(MonolineBrand).order_by(MonolineBrand.updated_at.desc()).limit(1)
            )).scalar_one_or_none()
            if row is None:
                row = MonolineBrand(label=label or "Monoline", theme=theme or "mono-ink")
                session.add(row)
            if label is not None:
                row.label = label
            if theme is not None:
                row.theme = theme
            if accent is not None:
                row.accent = accent or None
            if logo_name is not None:
                row.logo_name = logo_name or None
            await session.commit()
            await session.refresh(row)
            return {"id": str(row.id), "label": row.label, "theme": row.theme,
                    "accent": row.accent, "logo_name": row.logo_name}


store = MonolineStore()
