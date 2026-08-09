import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { SectionCard } from './SectionCard'
import type { PipelineItem } from '../../api'
import { fileUrl } from '../../api/client'
import { Icon, Modal, type BadgeTone } from '../ui'

/** 流水线状态 → 徽章色调（单一真相源，wave12 合并各组件重复定义）。 */
export const PIPELINE_ITEM_TONE: Record<string, BadgeTone> = {
  discovered: 'neutral',
  downloaded: 'primary',
  scored: 'warning',
  queued: 'primary',
  approved: 'success',
  rejected: 'error',
  failed: 'error',
  published: 'success',
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
}: {
  title: string
  children: ReactNode
  emptyText?: string
  isEmpty?: boolean
}) {
  return (
    <SectionCard title={title} padded={false}>
      {isEmpty && emptyText ? <p className="p-3 text-sm text-text-disabled">{emptyText}</p> : children}
    </SectionCard>
  )
}

/** 阶段条目列表（Download / Score / Produce / 异常区复用）：空态 + 行列表 + 截断提示。 */
export function StageList({
  items,
  emptyText,
  renderRow,
  total,
}: {
  items: PipelineItem[]
  emptyText: string
  renderRow: (item: PipelineItem) => ReactNode
  /** 该阶段总计数（> 显示条数时提示截断） */
  total?: number
}) {
  const { t } = useTranslation()
  if (items.length === 0) {
    return <p className="p-3 text-sm text-text-disabled">{emptyText}</p>
  }
  return (
    <>
      <ul className="divide-y divide-border/60">{items.map(renderRow)}</ul>
      {total !== undefined && total > items.length && (
        <p className="border-t border-border/60 px-3 py-1.5 text-[10px] text-text-disabled">
          {t('console.shownLimit', { shown: items.length, total })}
        </p>
      )}
    </>
  )
}

/** 远程媒体 URL 是否为图片（Reddit preview / 常见图片扩展名）。 */
function isImageUrl(url: string): boolean {
  return /\.(jpe?g|png|webp|gif|avif)([?#]|$)/i.test(url) || /(i\.redd\.it|preview\.redd\.it)/.test(url)
}

/** 条目缩略图（各阶段共用）：本地封面/成片优先，远程图片兜底，无图占位。
 *  远程图加载失败回退占位（不残留空白块）。
 *  v0.2.4：有成片时点击缩略图播放成片（复用素材库 QuickPreview 的
 *  Modal + video controls 交互）；v0.2.5：播放 Modal 内可一键在
 *  Finder 定位成片（排查文件缺失），无成片时点击直达原始素材定位。 */
export function MediaThumb({ item, className = 'h-12 w-20' }: { item: PipelineItem; className?: string }) {
  const { t } = useTranslation()
  const [remoteFailed, setRemoteFailed] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [videoFailed, setVideoFailed] = useState(false)
  const cover = item.cover_path
  const video = item.video_path
  const remote = item.media_url && isImageUrl(item.media_url) ? item.media_url : null

  const thumb = (() => {
    const base = `${className} shrink-0 border border-border bg-surface-2 object-cover`
    if (cover) {
      return <img src={fileUrl(cover)} alt="" className={base} loading="lazy" />
    }
    if (video) {
      return <video src={fileUrl(video)} preload="metadata" muted className={base} />
    }
    if (remote && !remoteFailed) {
      return (
        <img
          src={remote}
          alt=""
          loading="lazy"
          onError={() => setRemoteFailed(true)}
          className={base}
        />
      )
    }
    return (
      <div
        className={`${className} flex shrink-0 items-center justify-center border border-border bg-surface-2`}
        title={t('audit.noMedia')}
      >
        <Icon name="console" size={14} className="text-text-disabled" />
      </div>
    )
  })()

  /** 在 Finder/资源管理器中定位（桌面排查路径，§13.1 用户显式触发）。 */
  function revealInFinder(path: string | null) {
    if (!path || !window.electron?.showItemInFolder) return
    window.electron.showItemInFolder(path)
  }

  if (!video) {
    // 无成片：点击直接定位原始素材/封面（有值才可点），排查「为什么没成片」
    const locate = item.raw_path ?? cover ?? null
    if (!locate) return <>{thumb}</>
    return (
      <button
        type="button"
        onClick={() => revealInFinder(locate)}
        title={t('console.revealRaw')}
        aria-label={t('console.revealRaw')}
        className="group relative shrink-0 focus-visible:outline-none"
      >
        {thumb}
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/25 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
          <Icon name="folder" size={20} className="text-white/90" />
        </span>
      </button>
    )
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setVideoFailed(false)
          setPlaying(true)
        }}
        title={t('console.playVideo')}
        aria-label={t('console.playVideo')}
        className="group relative shrink-0 focus-visible:outline-none"
      >
        {thumb}
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/25 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
          <Icon name="play" size={20} className="text-white/90" />
        </span>
      </button>
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
              src={fileUrl(video)}
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
    </>
  )
}

/** 紧凑条目行（Download / Score / Produce / Publish 阶段共用）：带缩略图。 */
export function StageItemRow({
  item,
  badge,
  right,
}: {
  item: PipelineItem
  badge?: ReactNode
  right?: ReactNode
}) {
  const { t } = useTranslation()
  return (
    <li className="flex items-center gap-3 px-3 py-2">
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
