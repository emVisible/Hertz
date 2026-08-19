import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { SectionCard } from './SectionCard'
import type { PipelineItem } from '../../api'
import { fileUrl } from '../../api/client'
import { Icon, Modal, type BadgeTone } from '../ui'

/** 流水线状态 → 徽章色调（单一真相源，wave12 合并各组件重复定义）。 */
export const PIPELINE_ITEM_TONE: Record<string, BadgeTone> = {
  discovered: 'neutral',
  downloaded: 'neutral',
  scored: 'primary',
  queued: 'warning',
  approved: 'success',
  published: 'success',
  rejected: 'error',
  failed: 'error',
}

/** 条目类型徽章（v0.8）：视频/图片/文本——标题旁一眼区分，方便工作流筛选。 */
export const ITEM_TYPE_BADGE: Record<string, { labelKey: string; tone: BadgeTone }> = {
  video_raw: { labelKey: 'console.typeVideo', tone: 'primary' },
  image_gallery: { labelKey: 'console.typeImage', tone: 'success' },
  text_only: { labelKey: 'console.typeText', tone: 'neutral' },
}

/** 卡片级缩略图尺寸（审核/预处理/发布卡片共用，避免魔数重复）。 */
export const THUMB_LG = 'h-24 w-40'

/** 流水线阶段容器：标题 + 条目区（计数由平铺菜单承担；空态由 StageList 或
 * 自身 isEmpty 承担——AXIOM §1.2 各司其职，不双份拦截）。 */
export function PipelineStage({
  title,
  children,
  emptyText,
  isEmpty,
  right,
}: {
  title: string
  children: ReactNode
  emptyText?: string
  isEmpty?: boolean
  /** 标题右侧插槽（排序控件等，v0.2.6） */
  right?: ReactNode
}) {
  return (
    <SectionCard title={title} right={right} padded={false}>
      {isEmpty && emptyText ? <p className="p-3 text-sm text-text-disabled">{emptyText}</p> : children}
    </SectionCard>
  )
}

/** 阶段条目列表（Download / Score / Produce / 异常区复用）：
 *  空态 + 行列表 + 无限滚动（v0.3.12 自动滚动加载，IntersectionObserver）。 */
export function StageList({
  items,
  emptyText,
  renderRow,
  total,
  pageSize = 50,
}: {
  items: PipelineItem[]
  emptyText: string
  renderRow: (item: PipelineItem) => ReactNode
  /** 该阶段总计数（> 显示条数时提示截断） */
  total?: number
  /** 每次滚动追加条数（v0.3.12） */
  pageSize?: number
}) {
  const { t } = useTranslation()
  const [shown, setShown] = useState(pageSize)
  const sentinelRef = useRef<HTMLDivElement>(null)

  // 无限滚动：sentinel 进入视口 → 追加一页（AXIOM §7.2 懒加载，避免一次性渲染上千 DOM）
  useEffect(() => {
    const node = sentinelRef.current
    if (!node || shown >= items.length) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown((prev) => Math.min(prev + pageSize, items.length))
        }
      },
      { rootMargin: '200px' },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [shown, items.length, pageSize])

  if (items.length === 0) {
    return <p className="p-3 text-sm text-text-disabled">{emptyText}</p>
  }
  const visible = items.slice(0, shown)
  return (
    <>
      <ul className="divide-y divide-border/60">{visible.map(renderRow)}</ul>
      <div ref={sentinelRef} className="h-px" aria-hidden />
      {total !== undefined && total > items.length && (
        <p className="border-t border-border/60 px-3 py-1.5 text-[10px] text-text-disabled">
          {t('console.shownLimit', { shown: items.length, total })}
        </p>
      )}
      {shown < items.length && (
        <p className="border-t border-border/60 px-3 py-1.5 text-center text-[10px] text-text-disabled">
          {t('console.scrollMore', { shown: visible.length, total: items.length })}
        </p>
      )}
    </>
  )
}

/** 远程媒体 URL 是否为图片（Reddit preview / 常见图片扩展名）。 */
function isImageUrl(url: string): boolean {
  return /\.(jpe?g|png|webp|gif|avif)([?#]|$)/i.test(url) || /(i\.redd\.it|preview\.redd\.it)/.test(url)
}

/** 本地媒体路径是否为视频（按扩展名；默认视频）。 */
function isVideoPath(path: string): boolean {
  return /\.(mp4|mkv|webm|mov|m4v)([?#]|$)/i.test(path)
}

/** 条目缩略图（各阶段共用）：本地封面/成片/下载素材优先，远程图片兜底，无图占位。
 *  远程图加载失败回退占位（不残留空白块）。
 *  v0.2.4：有成片时点击缩略图播放成片（复用素材库 QuickPreview 的
 *  Modal + video controls 交互）；v0.2.5：播放 Modal 内可一键在
 *  Finder 定位成片（排查文件缺失），无成片时点击直达原始素材定位。
 *  v0.2.6：尺寸类（className）作用于外层按钮/容器，内容统一填充——
 *  支持 h-full w-full 填充模式（审核卡大图），不再依赖 img 的固定尺寸。
 *  v0.8 预处理修复：回退链插入 raw_path（本地下载素材）——下载后未制作的
 *  视频/图片可预览；图片可点击查看大图，视频可点击播放。 */
export function MediaThumb({ item, className = 'h-12 w-20' }: { item: PipelineItem; className?: string }) {
  const { t } = useTranslation()
  const [remoteFailed, setRemoteFailed] = useState(false)
  const [coverFailed, setCoverFailed] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [videoFailed, setVideoFailed] = useState(false)
  // v0.8：本地下载素材预览（raw 视频播放 / raw 图片大图查看）
  const [rawPreview, setRawPreview] = useState(false)
  const [rawFailed, setRawFailed] = useState(false)
  const cover = item.cover_path
  const video = item.video_path
  const raw = item.raw_path
  const rawIsVideo = raw ? isVideoPath(raw) : null
  const remote = item.media_url && isImageUrl(item.media_url) ? item.media_url : null
  const sizing = className || 'h-12 w-20'
  // 媒体缓存版本（v0.8.9）：反复制作覆盖同名文件，URL 带 updated_at 强制刷新
  const ver = item.updated_at ?? item.seq ?? null
  const fill = 'h-full w-full border border-border bg-surface-2 object-cover'

  const thumb = (() => {
    // 回退链：封面 → 成片首帧 → 本地下载素材（v0.8）→ 远程图 → 占位
    if (cover && !coverFailed) {
      return (
        <img
          src={fileUrl(cover, ver)}
          alt=""
          loading="lazy"
          onError={() => setCoverFailed(true)}
          className={fill}
        />
      )
    }
    if (video) {
      return (
        <video
          src={fileUrl(video, ver)}
          preload="metadata"
          muted
          playsInline
          onLoadedMetadata={(e) => {
            // 无封面时显示首帧：metadata 就绪后跳到 0.1s 触发首帧绘制
            const el = e.currentTarget
            if (el.duration > 0.2 && el.currentTime === 0) el.currentTime = 0.1
          }}
          className={fill}
        />
      )
    }
    if (raw && rawIsVideo) {
      return (
        <video
          src={fileUrl(raw, ver)}
          preload="metadata"
          muted
          playsInline
          onLoadedMetadata={(e) => {
            const el = e.currentTarget
            if (el.duration > 0.2 && el.currentTime === 0) el.currentTime = 0.1
          }}
          className={fill}
        />
      )
    }
    if (raw && !rawIsVideo) {
      return (
        <img
          src={fileUrl(raw, ver)}
          alt=""
          loading="lazy"
          onError={() => setRemoteFailed(true)}
          className={fill}
        />
      )
    }
    if (remote && !remoteFailed) {
      return (
        <img
          src={remote}
          alt=""
          loading="lazy"
          onError={() => setRemoteFailed(true)}
          className={fill}
        />
      )
    }
    return (
      <div className="flex h-full w-full items-center justify-center border border-border bg-surface-2" title={t('audit.noMedia')}>
        <Icon name="console" size={14} className="text-text-disabled" />
      </div>
    )
  })()

  /** 在 Finder/资源管理器中定位（桌面排查路径，§13.1 用户显式触发）。 */
  function revealInFinder(path: string | null) {
    if (!path || !window.electron?.showItemInFolder) return
    window.electron.showItemInFolder(path)
  }

  // v0.8 点击语义：成片播放 / 本地素材预览（视频播放、图片查看）/ 远程图查看 / 定位文件
  function onClickThumb() {
    if (video) {
      setVideoFailed(false)
      setPlaying(true)
      return
    }
    if (raw) {
      setRawFailed(false)
      setRawPreview(true)
      return
    }
    if (remote) {
      setRemoteFailed(false)
      setRawPreview(true) // 复用预览 Modal：视频态仅 raw 路径走
      return
    }
    revealInFinder(item.raw_path ?? cover ?? null)
  }

  const buttonTitle = video
    ? t('console.playVideo')
    : raw || remote
      ? t('console.previewMedia')
      : t('console.revealRaw')

  return (
    <>
      <button
        type="button"
        onClick={onClickThumb}
        title={buttonTitle}
        aria-label={buttonTitle}
        className={`group relative shrink-0 ${sizing} focus-visible:outline-none`}
      >
        {thumb}
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/25 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
          <Icon name={video || (raw && rawIsVideo) ? 'play' : 'eye'} size={20} className="text-white/90" />
        </span>
      </button>

      {/* 成片播放 Modal（v0.2.4） */}
      <Modal open={playing} onClose={() => setPlaying(false)} width={820} title={item.title}>
        <div className="flex flex-col gap-2">
          {videoFailed ? (
            <div className="flex min-h-40 flex-col items-center justify-center gap-2 border border-error/40 bg-error/5 px-4 text-center">
              <Icon name="alert" size={22} className="text-error" />
              <p className="text-sm text-text-primary">{t('console.videoMissing')}</p>
              <button
                type="button"
                onClick={() => revealInFinder(video)}
                className="flex items-center gap-1.5 border border-border bg-surface-2 px-3 py-1.5 text-xs text-text-primary transition-colors hover:border-primary hover:text-primary"
              >
                <Icon name="folder" size={13} />
                {t('console.revealVideo')}
              </button>
            </div>
          ) : (
            <video
              src={fileUrl(video!, ver)}
              controls
              autoPlay
              onError={() => setVideoFailed(true)}
              className="max-h-[70vh] w-full bg-black"
            />
          )}
          <div className="flex items-center justify-end gap-2">
            {window.electron?.showItemInFolder && (
              <button
                type="button"
                onClick={() => revealInFinder(video)}
                className="flex items-center gap-1.5 px-2 py-1 text-xs text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
              >
                <Icon name="folder" size={13} />
                {t('console.revealVideo')}
              </button>
            )}
          </div>
        </div>
      </Modal>

      {/* 本地素材/远程图预览 Modal（v0.8）：raw 视频播放 / 图片大图查看 */}
      <Modal
        open={rawPreview}
        onClose={() => setRawPreview(false)}
        width={820}
        title={item.title}
      >
        <div className="flex flex-col gap-2">
          {rawFailed ? (
            <div className="flex min-h-40 flex-col items-center justify-center gap-2 border border-error/40 bg-error/5 px-4 text-center">
              <Icon name="alert" size={22} className="text-error" />
              <p className="text-sm text-text-primary">{t('console.videoMissing')}</p>
              {raw && (
                <button
                  type="button"
                  onClick={() => revealInFinder(raw)}
                  className="flex items-center gap-1.5 border border-border bg-surface-2 px-3 py-1.5 text-xs text-text-primary transition-colors hover:border-primary hover:text-primary"
                >
                  <Icon name="folder" size={13} />
                  {t('console.revealVideo')}
                </button>
              )}
            </div>
          ) : raw && rawIsVideo ? (
            <video
              src={fileUrl(raw, ver)}
              controls
              autoPlay
              onError={() => setRawFailed(true)}
              className="max-h-[70vh] w-full bg-black"
            />
          ) : (
            <div className="flex max-h-[70vh] items-center justify-center overflow-auto bg-surface-2">
              {/* raw 图片优先，远程图兜底（MediaThumb 回退链一致） */}
              <img
                src={raw ? fileUrl(raw, ver) : (remote ?? '')}
                alt={item.title}
                onError={() => setRawFailed(true)}
                className="max-h-full max-w-full object-contain"
              />
            </div>
          )}
          {(raw || remote) && window.electron?.showItemInFolder && (
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => revealInFinder(raw ?? null)}
                className="flex items-center gap-1.5 px-2 py-1 text-xs text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
              >
                <Icon name="folder" size={13} />
                {t('console.revealVideo')}
              </button>
            </div>
          )}
        </div>
      </Modal>
    </>
  )
}

/** 紧凑条目行（Download / Score / Produce / Publish 阶段共用）：带缩略图。 */
export function StageItemRow({
  item,
  badge,
  right,
  selected,
  selectMode,
  onSelect,
}: {
  item: PipelineItem
  badge?: ReactNode
  right?: ReactNode
  /** 已选中（wave10.1 批量选择模式）：高亮 */
  selected?: boolean
  /** 批量选择模式（wave10.1）：点击整行切换选中（交互元素除外） */
  selectMode?: boolean
  onSelect?: (item: PipelineItem) => void
}) {
  const { t } = useTranslation()
  return (
    <li
      onClick={(e) => {
        if (!onSelect || !selectMode) return
        if ((e.target as HTMLElement).closest('button,a,label,input,textarea,summary')) return
        e.preventDefault()
        onSelect(item)
      }}
      className={`flex items-center gap-3 px-3 py-2 ${
        selected ? 'bg-primary/5' : ''
      } ${selectMode ? 'cursor-pointer' : ''}`}
    >
      {/* 选中指示（wave10.1）：左侧竖条——不占布局、无常驻 checkbox */}
      {selectMode && (
        <span
          className={`w-1 shrink-0 rounded-full transition-colors ${
            selected ? 'bg-primary' : 'bg-transparent'
          }`}
          aria-hidden
        />
      )}
      <MediaThumb item={item} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <p className="min-w-0 flex-1 truncate text-sm text-text-primary" title={item.title}>
            {item.title}
          </p>
          {item.is_lowscore && (
            <span className="shrink-0 border border-warning/50 px-1.5 py-0.5 text-[10px] leading-none text-warning">
              {t('console.lowScore')}
            </span>
          )}
        </div>
        <p className="mt-0.5 truncate text-xs text-text-disabled">
          r/{item.subreddit} · u/{item.author} · r{item.reddit_score}
          {item.score_total != null && <> · AI {item.score_total.toFixed(1)}</>}
        </p>
        {item.error && (
          <p className="mt-0.5 truncate text-xs text-error" title={item.error}>
            {item.error}
          </p>
        )}
      </div>
      {badge && <div className="shrink-0">{badge}</div>}
      {right && <div className="flex shrink-0 items-center gap-1.5">{right}</div>}
    </li>
  )
}
