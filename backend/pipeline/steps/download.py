"""download step — fetch the raw media for a scored item.

Reuses the Wave-2 ChunkedDownloader (Range-aware, resumable, SSRF-guarded).
v0.2.9（参考原项目 Autarkeia download.py）：候选链降级 + CDN 熔断 +
条间节奏 + 请求头补齐；v0.3.1：候选链全失败后 yt-dlp 兜底（内置 Reddit
提取器处理 v.redd.it）+ HTML 页面嗅探丢弃。

流程：
1. CDN 熔断中 → 条目保持 discovered（不 FAILED），保护队列
2. 候选链（DASH 变体 → 原 URL → permalink）逐个尝试
3. 403 → 熔断记账；404/网络 → 下一候选；全失败 → yt-dlp 兜底
4. 静图（image_gallery）：大小上限 + 最小字节校验 + 独立重试
"""

import logging
from pathlib import Path

from backend.infrastructure.storage import next_output_slug
from backend.models.session import session_factory
from backend.pipeline.base import Pipe, ProcessResult, StepContext, StepError

logger = logging.getLogger(__name__)


async def _ytdlp_download(url: str, dest: Path) -> Path:
    """yt-dlp（v0.8.1 参考原项目：有 cookie 时优先抓 permalink，内置 Reddit
    提取器解析 HLS/DASH——实测 v.redd.it DASH_720.mp4 403 时此路可通）。

    输出到 dest 同目录（扩展名由 yt-dlp 决定），返回实际产物路径。
    """
    import asyncio

    from backend.pipeline.download import download_headers

    def _run() -> Path:
        import yt_dlp

        template = str(dest.with_name(f"{dest.stem}.%(ext)s"))
        opts = {
            "format": "bv*+ba/b",  # v0.8.1：音视频分离合并（原项目同款）
            "merge_output_format": "mp4",
            "outtmpl": template,
            "quiet": True,
            "no_warnings": True,
            "noplaylist": True,
            "http_headers": download_headers(url),
            "socket_timeout": 30,
        }
        # 参考原项目 ytdlp_cookie_args：cookie 文件存在即带（Netscape 格式）
        try:
            from backend.pipeline.reddit_cookies import cookies_file_path

            cookie_path = cookies_file_path()
            if cookie_path.exists() and cookie_path.stat().st_size >= 40:
                opts["cookiefile"] = str(cookie_path)
        except Exception:  # noqa: BLE001 — cookie 不可用不影响
            pass
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.download([url])
        # 产物 = template 的实际文件（去掉多余部分：best.xxx 或 url.xxx）
        candidates = sorted(dest.parent.glob(f"{dest.stem}.*"))
        media = [p for p in candidates if p.suffix.lower() in (".mp4", ".mkv", ".webm")]
        if not media:
            raise RuntimeError("yt-dlp produced no media file")
        final = dest.with_suffix(media[0].suffix)
        if final != media[0]:
            media[0].replace(final)
        return final

    return await asyncio.to_thread(_run)


class DownloadStep(Pipe):
    name = "download"
    input_statuses: tuple[str, ...] = ("scored",)  # v0.8.6 评分先行

    async def process(self, ctx: StepContext, item) -> ProcessResult:
        from urllib.parse import urlparse

        from backend.download.engine import ChunkedDownloader, is_safe_media_url
        from backend.pipeline.download import (
            STILL_MAX_BYTES,
            STILL_MIN_BYTES,
            cdn_circuit_open,
            cdn_circuit_remaining,
            clear_resource_cooldown,
            domain_of,
            download_headers,
            download_pacing,
            looks_like_html,
            looks_like_manifest,
            media_candidates,
            note_resource_failure,
            reset_cdn_circuit,
            resource_cooldown_left,
            trip_cdn_circuit,
        )

        # 空壳隔离（v0.33）：批量路径已由 `engine._pending` 挡掉，这里挡的是
        # 手动单条下载与旁路批量（skip_score）——它们不经过 _pending。判据只有一个
        # 作者（quality.shell_reason → items.is_invalid），步骤只消费结论。
        if getattr(item, "is_invalid", False):
            ctx.log(f"[download] 条目无可用媒体（已隔离），跳过：{item.title[:40]}")
            return ProcessResult(status="discovered", skip=True)

        # v0.11.7 情感故事产线：文字帖无媒体——分配产物目录后直接进入
        # downloaded（produce 走文字分支：脚本 → TTS → 图文合成）
        if (item.item_type or "") == "text_only":
            root = Path(ctx.settings.data_dir) / "pipeline"
            if not item.output_dir:
                slug = next_output_slug(root)
                async with session_factory() as session:
                    row = await session.get(type(item), item.id)
                    if row is not None:
                        row.output_dir = f"pipeline/{slug}"
                        await session.commit()
                item.output_dir = f"pipeline/{slug}"
            ctx.log(f"[download] text_only story — no media, skipping ({item.title[:40]})")
            return ProcessResult(status="downloaded", data={})

        url = item.media_url or item.source_url
        if not url:
            raise StepError("item has no source URL to download")

        # v0.8.1 错位数据归一化（参考原项目 _invalid_collect_media）：
        # 历史条目 source_url 误存 v.redd.it 裸媒体链接（RSS 路径缺陷）——
        # 视其为 media_url，并用构造的 comments permalink 作 yt-dlp 抓取目标
        from urllib.parse import urlparse as _urlparse

        permalink = item.source_url or ""
        # source_url 误存 v.redd.it 裸媒体链接（历史 RSS 错位）→ 构造 comments permalink
        if (urlparse(url).hostname or "") == "v.redd.it" and "/comments/" not in permalink:
            vid = (urlparse(url).path or "").strip("/").split("/")[0]
            if vid:
                permalink = f"https://www.reddit.com/comments/{vid}/"

        # 媒体域冰封（v0.3.6 冰川式）：该域被 403 冻结 → 跳过，冷却到期后自动重试
        left = await resource_cooldown_left(url)
        if left > 0:
            ctx.log(
                f"[download] {domain_of(url)} frozen ({left}s left) — "
                "keeping discovered, skipping"
            )
            return ProcessResult(status="discovered", skip=True)

        # SSRF guard (AXIOM §8.1): collector-supplied URLs are remote input.
        checker = is_safe_media_url
        if getattr(ctx.settings, "pipeline_allow_loopback_urls", False):
            checker = lambda u: _urlparse(u).scheme in ("http", "https")  # noqa: E731

        # CDN 熔断：保护队列——剩余条目保持状态，冷却后重试
        if cdn_circuit_open():
            left = cdn_circuit_remaining()
            ctx.log(f"[download] CDN cooling down ({left}s left) — skipping")
            return ProcessResult(status="discovered", skip=True)

        # v0.8.1 参考原项目 prefer_ytdlp_when_auth：有 cookie 时 yt-dlp 抓
        # permalink 优先（内置 Reddit 提取器解析 HLS——DASH 直下 403 时可通）
        try:
            from backend.pipeline.reddit_cookies import cookies_file_path as _cfp

            _cookie_ok = _cfp().exists() and _cfp().stat().st_size >= 40
        except Exception:  # noqa: BLE001
            _cookie_ok = False
        root = Path(ctx.settings.data_dir) / "pipeline"
        if not item.output_dir:
            slug = next_output_slug(root)
            async with session_factory() as session:
                row = await session.get(type(item), item.id)
                if row is not None:
                    row.output_dir = f"pipeline/{slug}"
                    await session.commit()
            item.output_dir = f"pipeline/{slug}"
        directory = root / item.output_dir.split("/")[-1]
        dest = directory / "raw"
        ext = _ext_from(url)
        if ext:
            dest = dest.with_suffix(ext)

        if _cookie_ok and permalink and permalink != url:
            try:
                ytdlp_path = await _ytdlp_download(permalink, dest)
                size = ytdlp_path.stat().st_size if ytdlp_path.exists() else 0
                if size >= STILL_MIN_BYTES:
                    ctx.log(
                        f"[download] yt-dlp (cookie) ✓ {item.title[:40]} → "
                        f"{ytdlp_path.name} ({size} bytes)"
                    )
                    return ProcessResult(
                        status="downloaded",
                        data={"raw_path": str(ytdlp_path.resolve())},
                    )
                ytdlp_path.unlink(missing_ok=True)
            except Exception as exc:  # noqa: BLE001 — 失败落回候选链
                ctx.log(f"[download] yt-dlp cookie path failed: {exc} — falling back")

        candidates = media_candidates(url, item.source_url, checker=checker)
        if not candidates:
            raise StepError(f"download refused: unsafe media URL ({url[:64]})")

        # OAuth 签名直链（v0.3.7）：v.redd.it 匿名 403 时用官方签名 URL 插到首位，
        # 优先走签名链（CDN 放行），失败再落回匿名候选
        try:
            from backend.pipeline.reddit_media import _signed_url_safe, resolve_direct_video


            signed = await resolve_direct_video(item.source_id, url)
            if signed and _signed_url_safe(signed) and checker(signed):
                if signed not in candidates:
                    candidates.insert(0, signed)
                    ctx.log(f"[download] OAuth signed direct link ✓ {signed[:64]}")
        except Exception:  # noqa: BLE001 — 签名解析失败不阻塞匿名链
            logger.info("oauth direct resolve failed for %s: skip", url[:48])

        root = Path(ctx.settings.data_dir) / "pipeline"
        if not item.output_dir:
            # 结构化命名：pipeline/2026-08-04-01（日期 + 当日第几次），并持久化供后续步骤复用
            slug = next_output_slug(root)
            async with session_factory() as session:
                row = await session.get(type(item), item.id)
                if row is not None:
                    row.output_dir = f"pipeline/{slug}"
                    await session.commit()
            item.output_dir = f"pipeline/{slug}"
        directory = root / item.output_dir.split("/")[-1]
        dest = directory / "raw"
        ext = _ext_from(url)
        if ext:
            dest = dest.with_suffix(ext)

        await download_pacing()  # 条间延迟 + 抖动（防节奏整齐被封）

        is_still = (item.item_type or "") == "image_gallery"
        last_error = ""
        for attempt in range(3 if is_still else 1):
            for cand in candidates:
                # v0.8.9 MPD→CMAF 路径（参考原项目 _download_via_mpd_direct）：
                # DASH_720.mp4 被 CDN 403，但 MPD 主清单与 CMAF 分片放行——
                # 实测匿名环境唯一可靠的 Reddit 视频通道
                if cand.endswith(".mpd"):
                    from backend.pipeline.download import download_via_mpd

                    mpd_dest = await download_via_mpd(
                        cand, dest,
                        headers=download_headers(cand),
                        checker=checker,
                    )
                    if mpd_dest is not None:
                        reset_cdn_circuit()
                        await clear_resource_cooldown(url)
                        size = mpd_dest.stat().st_size
                        ctx.log(
                            f"[download] MPD/CMAF ✓ {item.title[:40]} → "
                            f"{mpd_dest.name} ({size} bytes)"
                        )
                        return ProcessResult(
                            status="downloaded",
                            data={"raw_path": str(mpd_dest.resolve())},
                        )
                    last_error = f"{cand[:48]}: MPD/CMAF failed"
                    continue
                try:
                    downloader = ChunkedDownloader(
                        cand, dest,
                        headers=download_headers(cand),
                        url_checker=checker,
                    )
                    result = await downloader.download()
                except Exception as exc:  # noqa: BLE001 — 候选级失败继续下一候选
                    last_error = f"{cand[:48]}: {exc}"
                    continue
                if not result.ok:
                    # 403 附排查提示（v0.3.0）：CDN 拒绝通常 = Reddit 封锁出口 IP
                    hint = ""
                    if result.status == 403:
                        from backend.config import settings

                        oauth_hint = (
                            ""
                            if settings.pipeline_reddit_client_id
                            else "；建议在 设置→流水线 配置 Reddit OAuth 凭证解锁"
                        )
                        hint = f"（CDN 拒绝——检查网络/代理{oauth_hint}）"
                        # 域级冰封（v0.3.6 冰川式）：403 → 该媒体域指数退避冷却
                        await note_resource_failure(cand, error=result.error)
                    last_error = f"{cand[:48]}: {result.error}{hint}"
                    status = result.status
                    if status == 403:
                        if trip_cdn_circuit():
                            # 熔断刚触发：剩余候选同 CDN 大概率全拒，直接放弃本轮
                            ctx.log("[download] CDN 403 — circuit tripped")
                            return ProcessResult(status="discovered", skip=True)
                    else:
                        reset_cdn_circuit()  # 非 403 重置连续计数
                    continue
                reset_cdn_circuit()
                await clear_resource_cooldown(url)  # 域内成功 → 解冻
                size = dest.stat().st_size if dest.exists() else 0
                # 内容嗅探（v0.2.9 查漏补缺）：误下 MPD/HLS 清单文本 → 丢弃继续下一候选
                if size > 0:
                    head = dest.read_bytes()[:512]
                    if looks_like_manifest(head):
                        last_error = f"{cand[:48]}: manifest text, not media"
                        dest.unlink(missing_ok=True)
                        continue
                    if looks_like_html(head):
                        # v0.3.1：v.redd.it/{id} 分享页是 HTML 而非媒体 → 丢弃
                        last_error = f"{cand[:48]}: html page, not media"
                        dest.unlink(missing_ok=True)
                        continue
                if is_still and (size < STILL_MIN_BYTES or size > STILL_MAX_BYTES):
                    last_error = (
                        f"{cand[:48]}: still size {size} out of "
                        f"[{STILL_MIN_BYTES}, {STILL_MAX_BYTES}]"
                    )
                    dest.unlink(missing_ok=True)
                    continue
                ctx.log(f"[download] {item.title[:40]} → {dest.name} ({size} bytes)")
                return ProcessResult(
                    status="downloaded",
                    data={"raw_path": str(dest.resolve())},
                )
            if attempt < 1:
                dest.unlink(missing_ok=True)  # 重试前清残留

        # yt-dlp 兜底（v0.3.1，参考原项目）：候选链全失败后交给 yt-dlp——
        # 内置 Reddit 提取器能处理 v.redd.it（带 UA/referer，走代理解析）
        try:
            ytdlp_path = await _ytdlp_download(item.source_url or url, dest)
            size = ytdlp_path.stat().st_size if ytdlp_path.exists() else 0
            if size < STILL_MIN_BYTES:
                ytdlp_path.unlink(missing_ok=True)
                raise RuntimeError("yt-dlp output too small")
            ctx.log(
                f"[download] yt-dlp fallback ✓ {item.title[:40]} → "
                f"{ytdlp_path.name} ({size} bytes)"
            )
            return ProcessResult(
                status="downloaded",
                data={"raw_path": str(ytdlp_path.resolve())},
            )
        except Exception as exc:  # noqa: BLE001 — 兜底失败保留原错误
            logger.info("yt-dlp fallback failed for %s: %s", item.title[:40], exc)

        raise StepError(f"download failed: {last_error or 'all candidates failed'}")

    # ---------- internals ----------


def _ext_from(url: str) -> str:
    from urllib.parse import urlparse

    name = urlparse(url).path.rsplit("/", 1)[-1]
    if "." in name:
        return "." + name.rsplit(".", 1)[-1].lower()
    return ".mp4"
