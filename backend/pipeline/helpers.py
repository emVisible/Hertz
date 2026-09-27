"""Pipeline 域共享助手（v0.8 查漏补缺）：消除 service/engine 的重复骨架。"""

from backend.models import script_keys
from backend.models.item import Item
from backend.models.session import session_factory
from backend.pipeline.errors import InvalidItemStateError, ItemNotFoundError


async def load_item_for_action(
    item_id, allowed_statuses: tuple, action: str
) -> Item:
    """加载条目并校验状态（6+ 处重复骨架收敛）。

    不存在 → ItemNotFoundError（404）；状态不允许 → InvalidItemStateError（409）。
    返回的 Item 在调用方自己的 session 事务内使用（commit 由调用方负责）。
    """
    async with session_factory() as session:
        item = await session.get(Item, item_id)
        if item is None:
            raise ItemNotFoundError(item_id)
        if item.status not in allowed_statuses:
            raise InvalidItemStateError(
                f"cannot {action} item in state {item.status}"
            )
        return item


def back_status_for(item: Item) -> str:
    """回退状态机（v0.8.6 评分先行）：有成片→downloaded（重制）/ 已下载→scored（重下载）/
    否则→discovered（重评分）。retry 与 retry_class 共用。"""
    return (
        "downloaded"
        if item.video_path
        else ("scored" if item.raw_path else "discovered")
    )


async def bump_item_seq(session, item: Item) -> None:
    """状态迁移触达时刷新入库序（v0.8.9）：打回/重试/恢复/批量流转 = 最新入库序。

    用户诉求：各处的「入库序」应随真实入库操作改变——打回的条目应像刚入库
    一样排在列表最前。seq 为 Identity(BY DEFAULT) 列，可手动赋值为 max+1。
    """
    from sqlalchemy import func, select

    max_seq = (
        await session.execute(select(func.max(Item.seq)))
    ).scalar_one()
    item.seq = (max_seq or 0) + 1


# 重制后保留的发布元数据（对齐原项目 _purge_derived_media：bili_* 字段保留——
# 用户可能在审核页手动改过标题/分区；旁白与字幕缓存清除，重制必然重生成）
_PURGE_KEEP_SCRIPT_KEYS = tuple(script_keys.ARCHIVE_SAFE_KEYS)


async def purge_derived_media(item: Item, *, keep_raw: bool = True) -> None:
    """清除派生媒体（v0.8.9，对齐原项目 reproduce/_purge_derived_media）。

    打回/重试时删除旧成片/配音/字幕/封面文件（含同名 srt/ass）并清空字段——
    审核侧不再看到旧成片，重制必然全新；照片（raw）保留。
    script_json 保留用户手动改过的发布元数据（bili_title/bili_tid），
    清旁白/字幕/降级缓存（重制会重新生成）。
    """
    import asyncio
    from pathlib import Path

    async def unlink(p: str | None) -> None:
        if not p:
            return
        path = Path(p)
        for suffix in ("", ".srt", ".ass", ".asr.srt"):
            target = path.with_suffix(path.suffix + suffix) if suffix else path
            try:
                await asyncio.to_thread(target.unlink, missing_ok=True)
            except OSError:
                pass

    for field in ("video_path", "audio_path", "subtitle_path", "cover_path"):
        await unlink(getattr(item, field))
        setattr(item, field, None)

    if item.script_json:
        kept = {
            k: v for k, v in (item.script_json or {}).items()
            if k in _PURGE_KEEP_SCRIPT_KEYS
        }
        item.script_json = kept or None

    if not keep_raw:

        item.raw_path = None


async def clear_item_disk(item: Item) -> None:
    """归档磁盘清理（wave10）：删除条目全部磁盘资源并清空对应字段。

    覆盖 raw/video/audio/subtitle/cover 文件（含 srt/ass/asr.srt/thumb 变体）
    与整个 output_dir 目录（pipeline/{slug}/）；路径为空或文件缺失静默跳过。
    调用方负责 commit。"""
    import asyncio
    from pathlib import Path

    from backend.infrastructure.storage import FileStore

    async def unlink(p: str | None) -> None:
        if not p:
            return
        path = Path(p)
        for suffix in ("", ".srt", ".ass", ".asr.srt", ".thumb.jpg"):
            target = path.with_suffix(path.suffix + suffix) if suffix else path
            try:
                await asyncio.to_thread(target.unlink, missing_ok=True)
            except OSError:
                pass

    for field in ("video_path", "audio_path", "subtitle_path", "cover_path"):
        await unlink(getattr(item, field))
        setattr(item, field, None)

    await unlink(item.raw_path)
    item.raw_path = None

    if item.output_dir:
        try:
            store = FileStore()
            out = store.data_dir / item.output_dir
            if out.is_dir():
                import shutil

                await asyncio.to_thread(shutil.rmtree, out, ignore_errors=True)
        except OSError:
            pass
        item.output_dir = None


def _auto_tid(item) -> int | None:
    """分区自动建议：subreddit/关键词 → tid（参考原项目 assign_bili_tid）。"""
    try:
        from backend.pipeline.category import assign_bili_tid

        return assign_bili_tid(item.subreddit or "", item.item_type)
    except Exception:  # noqa: BLE001 — 建议失败不影响序列化
        return None



async def get_channel(public_id: str | None):
    """栏目查询（v0.22 栏目化，非破坏性）：key 空/栏目不存在/未启用 → None，
    调用方全部回落原逻辑。"""
    if not public_id:
        return None
    from sqlalchemy import select

    from backend.models.channel import Channel

    async with session_factory() as session:
        return (
            await session.execute(
                select(Channel).where(
                    Channel.public_id == public_id, Channel.enabled.is_(True)
                )
            )
        ).scalar_one_or_none()


async def find_channel_for_source(raw_channel: str):
    """按采集通道反查启用栏目（v0.22：source_pool 包含该通道的第一个栏目）。"""
    from sqlalchemy import select

    from backend.models.channel import Channel

    async with session_factory() as session:
        channels = (
            await session.execute(select(Channel).where(Channel.enabled.is_(True)))
        ).scalars().all()
    for channel in channels:
        if raw_channel in (channel.source_pool or []):
            return channel
    return None


async def active_channel_bindings() -> dict[str, str]:
    """启用栏目 source_pool → public_id 映射（v0.22 栏目化，非破坏性：
    空表返回空 dict——collect 不打标，全部条目走原逻辑）。"""
    from sqlalchemy import select

    from backend.models.channel import Channel

    async with session_factory() as session:
        channels = (
            await session.execute(select(Channel).where(Channel.enabled.is_(True)))
        ).scalars().all()
    binding: dict[str, str] = {}
    for channel in channels:
        for src in channel.source_pool or []:
            binding[src] = channel.public_id
    return binding


def normalize_produce_flags(opts: dict | None) -> dict:
    """生产方式标志归一（v0.22.x 单一真相源）：media._produce_item 与
    制作前预检共用同一套默认/部分设置语义——两处漂移即预检失真。"""
    flags = dict(opts or {})
    if not flags:
        return {
            "passthrough": True, "voice": False,
            "subtitle": False, "translate": False, "mute": False,
        }
    flags.setdefault("voice", False)
    flags.setdefault("subtitle", True)
    flags.setdefault("translate", True)
    flags.setdefault("mute", False)
    for key in ("passthrough", "voice", "subtitle", "translate", "mute"):
        flags[key] = bool(flags.get(key))
    return flags
