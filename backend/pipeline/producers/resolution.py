"""成片画幅的唯一权威源（v0.37）。

## 为什么要这么一块

720p 原本散在 5 个文件共 8 处（`assemble` 的目标画幅、`compose` 的 scale/pad、
`subtitles` 的 ASS `PlayResX/Y`、`cover` 的裁切…）。其中最要命的一对是：

- `compose` 产出 **1280×720** 的视频
- `subtitles` 往里烧 ASS 字幕，头部写 **`PlayResX: 1280` / `PlayResY: 720`**

ASS 的 `PlayRes` 声明的是字幕坐标系。视频尺寸变了而它没变，字号与边距会按
旧坐标系缩放——**不是报错，是静默的视觉错误**：字幕变小或变大到出界，而
没有任何日志。所以这两处必须是同一个数，不能是两份恰好相等的字面量。

## 分成两类的理由

- **成片画幅**（本模块）：视频本体 + 烧进去的字幕，必须一致。
- **封面 / 标题卡**：它们是**独立交付物**——封面要上传成图，标题卡是一张 PNG，
  都不烧字幕、也不与视频逐像素对齐。把它们绑到成片分辨率上，1080p 机器会
  生成一张巨大的封面图，而 B 站封面规格根本不是那个尺寸。

## 与设置的边界

`pipeline_video_width/height/fps` 控制成片；`cover` 与 story 卡继续用本模块的
`_DELIVERY_*` 常量。这是刻意的分离，不是遗漏。
"""

from backend.config import settings

#: 封面 / 标题卡等独立交付物的尺寸（B 站封面规格，与成片无关）。
_DELIVERY_WIDTH = 1280
_DELIVERY_HEIGHT = 720

#: 无设置时的兜底，保持与历史行为完全一致。
_FALLBACK = (1280, 720, 30)

#: 允许的分辨率档位。开放成任意数字等于让用户填出 1279×721 这种
#: 既不标准、又会让每个编码器的 scale/pad 分支各写一遍的尺寸。
_ALLOWED_WIDTHS = (1280, 1920, 2560, 3840)
_ALLOWED_HEIGHTS = (720, 1080, 1440, 2160)
_ALLOWED_FPS = (24, 25, 30, 60)


def _pick(value: object, allowed: tuple[int, ...], fallback: int) -> int:
    """在允许档位里取值；不在其中则回落到默认。

    回退而不是抛异常或放行：用户填错一个分辨率，正确的反应是「按默认出片」，
    不是让整个产出流程失败。但也不能悄悄放行——那样得到的是一台机器认不出
    的尺寸，比默认更糟。
    """
    try:
        n = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return fallback
    return n if n in allowed else fallback


def target_resolution() -> tuple[int, int, int]:
    """成片画幅 (宽, 高, 帧率)——视频与字幕共用这一个答案。"""
    return (
        _pick(getattr(settings, "pipeline_video_width", None), _ALLOWED_WIDTHS, _FALLBACK[0]),
        _pick(getattr(settings, "pipeline_video_height", None), _ALLOWED_HEIGHTS, _FALLBACK[1]),
        _pick(getattr(settings, "pipeline_video_fps", None), _ALLOWED_FPS, _FALLBACK[2]),
    )


def delivery_resolution() -> tuple[int, int]:
    """封面 / 标题卡尺寸——独立交付物规格，不跟随成片。"""
    return _DELIVERY_WIDTH, _DELIVERY_HEIGHT