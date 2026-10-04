import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { ReactNode } from 'react'

import type { PipelineItem, ProduceOptions } from '../../api'
import { useExecutionStore } from '../../stores/execution'
import { Badge, Button, Icon } from '../ui'
import { ITEM_TYPE_BADGE, MediaThumb, PIPELINE_ITEM_TONE } from './PipelineStage'
import { normalizeOptions, ProduceOptionsPicker } from './ProduceOptionsPicker'

/** 预处理卡片（v0.8.9）：仅服务「已下载未加工」阶段——大媒体 + 生产方式选择 +
 *  制作主操作（评分/下载已在紧凑行完成，步骤条与子 menu 重复已移除）。
 *  wave11：制作中按钮变「取消制作」——点错/视频过长可中止（后端检查点回滚）。 */
export function PreReviewCard({
  item,
  onSaveOptions,
  onProduce,
  onCancelProduce,
  onReject,
  onUploadCover,
  pick,
}: {
  item: PipelineItem
  onSaveOptions: (item: PipelineItem, options: Partial<ProduceOptions>) => void
  onProduce: (item: PipelineItem) => void
  onCancelProduce: (item: PipelineItem) => void
  onReject: (item: PipelineItem) => void
  onUploadCover: (item: PipelineItem, file: File) => void
  /** 「捞入今日」（v0.34 D-218）：入口由列表侧决定（`TodayPick`） */
  pick?: ReactNode
}) {
  const { t } = useTranslation()
  // v0.11.3：制作进行中——按钮转圈 + 防重复提交（长任务，禁连点）
  const busy = useExecutionStore((s) => s.pipeline.busy[item.id])
  const [options, setOptions] = useState<ProduceOptions>(() =>
    normalizeOptions(item.produce_options),
  )
  const hasRaw = !!item.raw_path
  const hasVideo = !!item.video_path
  const coverInputRef = useRef<HTMLInputElement>(null)

  // 生产方式本地即时反馈（v0.8.3）：点击立即变色，后端刷新后以服务器为准
  useEffect(() => {
    setOptions(normalizeOptions(item.produce_options))
  }, [item.produce_options])

  function changeOptions(next: Partial<ProduceOptions>) {
    setOptions(normalizeOptions({ ...options, ...next })) // 本地先变（即时视觉）
    onSaveOptions(item, next)
  }


  return (
    <li className="group flex gap-5 px-4 py-4">
      {/* 左侧大媒体（相册感，可点击播放） */}
      <div className="group/cover relative aspect-video w-1/3 shrink-0">
        <div className="aspect-video overflow-hidden rounded-lg shadow-sm">
          <MediaThumb item={item} className="h-full w-full" />
        </div>
        <button
          type="button"
          onClick={() => coverInputRef.current?.click()}
          title={t('console.changeCover')}
          aria-label={t('console.changeCover')}
          className="absolute bottom-1.5 right-1.5 flex h-7 w-7 items-center justify-center rounded-full border border-border bg-black/55 text-white/90 opacity-0 backdrop-blur-sm transition-opacity group-hover/cover:opacity-100 hover:border-primary hover:text-primary"
        >
          <Icon name="edit" size={13} />
        </button>
        <input
          ref={coverInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) onUploadCover(item, file)
            e.target.value = ''
          }}
        />
      </div>

      <div className="min-w-0 flex-1">
        {/* 标题 + 状态 */}
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary" title={item.title}>
            {item.title}
          </p>
          {ITEM_TYPE_BADGE[item.item_type] && (
            <Badge tone={ITEM_TYPE_BADGE[item.item_type].tone}>
              {t(ITEM_TYPE_BADGE[item.item_type].labelKey)}
            </Badge>
          )}
          <Badge tone={PIPELINE_ITEM_TONE[item.status] ?? 'neutral'}>{item.status}</Badge>
          {item.is_lowscore && (
            <span className="shrink-0 border border-warning/50 px-1.5 py-0.5 text-[10px] leading-none text-warning">
              {t('console.lowScore')}
            </span>
          )}
        </div>

        {/* meta 行：来源/作者/分数/互动（信息密度 v0.8.6） */}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-text-secondary">
          {item.source_url ? (
            <a
              href={item.source_url}
              target="_blank"
              rel="noopener noreferrer"
              title={t('console.viewSource')}
              className="border border-border px-1.5 py-0.5 text-[10px] text-text-secondary transition-colors hover:border-primary hover:text-primary"
            >
              r/{item.subreddit}
            </a>
          ) : (
            <Badge tone="neutral">r/{item.subreddit}</Badge>
          )}
          <Badge tone="neutral">u/{item.author}</Badge>
          <Badge tone="neutral">r{item.reddit_score}</Badge>
          {item.upvote_ratio > 0 && (
            <Badge tone={item.upvote_ratio >= 0.85 ? 'neutral' : 'warning'}>
              {Math.round(item.upvote_ratio * 100)}%↑
            </Badge>
          )}
          {/* AI 总分（v0.3.4：去掉评分维度，只留总分） */}
          {item.score_total != null
            ? <Badge tone="primary">AI {item.score_total.toFixed(1)}</Badge>
            : <span className="text-[11px] text-text-disabled">{t('console.pendingScore')}</span>}
          <span className="flex items-center gap-1 text-[11px]">
            <Icon name={hasRaw ? 'check' : 'grip'} size={11} className={hasRaw ? 'text-success' : 'text-text-disabled'} />
            {hasRaw ? t('console.downloaded') : t('console.pendingDownload')}
          </span>
        </div>

        {/* 生产方式（v0.3.4：点击即存，无保存按钮——减少操作步骤） */}
        <div className="mt-2 rounded-md border border-border/60 bg-surface-2/30 p-2">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wide text-text-disabled">{t('console.produce.title')}</span>
            {hasVideo && (
              <span className="flex items-center gap-1 text-[10px] text-success">
                <Icon name="check" size={10} />
                {t('console.produced')}
              </span>
            )}
          </div>
          <ProduceOptionsPicker
            value={options}
            compact
            onChange={(next) => changeOptions(next)}
          />
        </div>

        {/* 主操作（v0.8.9：卡片仅服务已下载未加工阶段——评分/下载已在行内完成） */}
        <div className="mt-2 flex items-center justify-end gap-2 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
          {pick}
          <Button size="sm" variant="danger" disabled={!!busy} onClick={() => onReject(item)}>
            <Icon name="close" size={12} />
            {t('console.reject')}
          </Button>
          {busy?.action === 'produce' ? (
            // wave11：制作中 → 取消按钮（点错/视频过长省资源；后端检查点回滚）
            <Button size="sm" variant="ghost" onClick={() => onCancelProduce(item)} title={t('console.produce.cancelHint')}>
              <Icon name="close" size={12} />
              {t('console.produce.cancel')}
            </Button>
          ) : (
            <Button
              size="sm"
              loading={!!busy}
              disabled={!!busy}
              onClick={() => onProduce(item)}
              title={t('console.produce.nowHint')}
            >
              <Icon name="play" size={12} />
              {busy ? t('console.busy.produce') : t('console.produce.now')}
            </Button>
          )}
        </div>
      </div>
    </li>
  )
}
