"""Autarkeia → Hertz 数据迁移（一次性脚本）。

迁移源：遗留 Autarkeia 项目的 SQLite（content_items / source_state）。
目标：Hertz PostgreSQL（items / source_state）。

发布安全（AXIOM §1.1 最小惊讶 / 账号安全）：
- 所有 published / approved 条目一律降级为 queued（进入人工审核队列）
- published_at / scheduled_at 强制置空——任何发布步骤都不可能被触发
- Hertz 侧 pipeline_publish_target 保持 noop，双保险
- 脚本默认只迁移内容与游标，不触达任何外部账号

用法：uv run python scripts/migrate_autarkeia.py [--db /path/to/autarkeia.db]
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sqlite3
from datetime import datetime
from pathlib import Path

from backend.models.item import Item
from backend.models.session import session_factory

# Autarkeia status → Hertz status（Hertz 无 produced；published/approved 一律降级）
STATUS_MAP = {
    "discovered": "discovered",
    "scored": "scored",
    "downloaded": "downloaded",
    "produced": "downloaded",
    "queued": "queued",
    "approved": "queued",  # 防发布：Hertz PublishStep 只吃 approved
    "rejected": "rejected",
    "published": "queued",  # 防发布：绝不保留已发布状态
    "failed": "failed",
}

TEXT_FIELDS = (
    "reddit_id", "subreddit", "title", "author", "url", "permalink",
    "ai_reason", "script", "bili_title", "bili_desc", "bili_tags",
    "raw_path", "audio_path", "video_path", "cover_path", "subtitle_path",
    "error_message", "phash", "bili_aid",
)
INT_FIELDS = (
    "reddit_score", "num_comments", "is_video", "is_lowscore",
    "bili_tid", "bili_copyright",
)
FLOAT_FIELDS = ("upvote_ratio", "ai_score", "created_utc")


def _row_to_dict(row: sqlite3.Row) -> dict:
    d = dict(row)
    for k in TEXT_FIELDS:
        if k in d and d[k] is None:
            d[k] = ""
    return d


def _parse_dt(value) -> datetime | None:
    """SQLite DATETIME 是字符串；统一解析为 aware datetime。"""
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


async def migrate_items(conn: sqlite3.Connection, *, dry_run: bool) -> dict:
    rows = conn.execute(
        "SELECT * FROM content_items ORDER BY id"
    ).fetchall()
    stats = {
        "migrated": 0,
        "skipped": 0,
        "downgraded_from_published": 0,
        "downgraded_from_approved": 0,
    }
    async with session_factory() as session:
        for raw in rows:
            d = _row_to_dict(raw)
            exists = (await session.execute(
                __import__("sqlalchemy").select(Item).where(
                    Item.source == "reddit", Item.source_id == d["reddit_id"]
                )
            )).scalar_one_or_none()
            if exists is not None:
                stats["skipped"] += 1
                continue
            old_status = d["status"]
            new_status = STATUS_MAP.get(old_status, "failed")
            if old_status == "published":
                stats["downgraded_from_published"] += 1
            if old_status == "approved":
                stats["downgraded_from_approved"] += 1
            if dry_run:
                stats["migrated"] += 1
                continue

            script_json = {}
            if d.get("script"):
                script_json["script"] = d["script"]
            for k in ("bili_title", "bili_desc", "bili_tags"):
                if d.get(k):
                    script_json[k] = d[k]
            if d.get("bili_tid") is not None:
                script_json["bili_tid"] = d["bili_tid"]
            if d.get("bili_copyright") is not None:
                script_json["bili_copyright"] = d["bili_copyright"]

            score_dimensions = None
            if d.get("ai_scores_json"):
                try:
                    parsed = json.loads(d["ai_scores_json"])
                    score_dimensions = parsed if isinstance(parsed, dict) else {"raw": parsed}
                except ValueError:
                    pass
            score_reasons = [d["ai_reason"]] if d.get("ai_reason") else None

            item = Item(
                status=new_status,
                item_type="video_raw",
                source="reddit",
                source_url=d.get("url", ""),
                source_id=d.get("reddit_id", ""),
                title=d.get("title", ""),
                subreddit=d.get("subreddit", ""),
                author=d.get("author", ""),
                reddit_score=int(d.get("reddit_score") or 0),
                upvote_ratio=float(d.get("upvote_ratio") or 1.0),
                num_comments=int(d.get("num_comments") or 0),
                score_total=d.get("ai_score"),
                score_dimensions=score_dimensions,
                score_reasons=score_reasons,
                raw_path=d.get("raw_path") or None,
                audio_path=d.get("audio_path") or None,
                video_path=d.get("video_path") or None,
                subtitle_path=d.get("subtitle_path") or None,
                cover_path=d.get("cover_path") or None,
                script_json=script_json or None,
                # 发布信息仅作记录；状态已降级 queued，不会触发发布
                publish_json={"target": "bilibili", "bili_aid": d.get("bili_aid") or None},
                phash=d.get("phash") or None,
                # 发布安全：绝不保留已发布/已排期时间
                published_at=None,
                error=d.get("error_message") or None,
            )
            session.add(item)
            stats["migrated"] += 1
        if not dry_run:
            await session.commit()
    return stats


async def migrate_source_state(conn: sqlite3.Connection, *, dry_run: bool) -> dict:
    """采集游标（16 条）：结构一致，直接拷贝，避免重新采集。"""
    from backend.models.pipeline import SourceState

    rows = conn.execute("SELECT * FROM source_state").fetchall()
    stats = {"migrated": 0, "skipped": 0}
    async with session_factory() as session:
        for raw in rows:
            d = dict(raw)
            exists = (await session.execute(
                __import__("sqlalchemy").select(SourceState).where(
                    SourceState.source == d["source"], SourceState.channel == d["channel"]
                )
            )).scalar_one_or_none()
            if exists is not None:
                stats["skipped"] += 1
                continue
            if dry_run:
                stats["migrated"] += 1
                continue
            session.add(SourceState(
                source=d["source"],
                channel=d["channel"],
                cursor_json=d.get("cursor_json"),
                cooldowns_json=d.get("cooldowns_json"),
                ok_count=int(d.get("ok_count") or 0),
                fail_count=int(d.get("fail_count") or 0),
                last_strategy=d.get("last_strategy"),
                last_run_at=_parse_dt(d.get("last_run_at")),
            ))
            stats["migrated"] += 1
        if not dry_run:
            await session.commit()
    return stats


async def main() -> None:
    parser = argparse.ArgumentParser(description="Autarkeia → Hertz 数据迁移（不发布）")
    default_db = str(Path.home() / "Code" / "Autarkeia" / "data" / "autarkeia.db")
    parser.add_argument("--db", default=default_db)
    parser.add_argument("--dry-run", action="store_true", help="仅统计，不写入")
    args = parser.parse_args()

    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row
    try:
        items = await migrate_items(conn, dry_run=args.dry_run)
        sources = await migrate_source_state(conn, dry_run=args.dry_run)
    finally:
        conn.close()

    mode = "DRY-RUN（未写入）" if args.dry_run else "已迁移"
    print(f"[{mode}] content_items: {items}")
    print(f"[{mode}] source_state: {sources}")
    print("⚠ 发布安全：published/approved 已降级 queued，published_at 已清空；")
    print("  请保持设置中的发布目标为 noop，审核通过后再手动发布。")


if __name__ == "__main__":
    asyncio.run(main())
