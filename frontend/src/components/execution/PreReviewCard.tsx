import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { PipelineItem, ProduceOptions } from '../../api'
import { Badge, Icon } from '../ui'
import { MediaThumb, PIPELINE_ITEM_TONE, THUMB_LG } from './PipelineStage'
import { ScoreDims } from './ScoreDims'
import { normalizeOptions, ProduceOptionsPicker } from './ProduceOptionsPicker'

/** 预处理卡片（v0.3.3）：生产方式人工选择（直发/配音/字幕/翻译/静音 模块多选）
 *  + 下载/评分/制作状态聚合。生产方式在下载后/生产前确定。 */
export function PreReviewCard({
  item,
  onSaveOptions,
}: {
  item: PipelineItem
  onSaveOptions: (item: PipelineItem, options: Partial<ProduceOptions>) => void
}) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<ProduceOptions | null>(null)
  const dims = item.score_dimensions
  const hasRaw = !!item.raw_path
  const hasVideo = !!item.video_path
  const hasCover = !!item.cover_path
  const options = draft ?? normalizeOptions(item.produce_options)

  return (
    <li className="flex gap-3 px-3 py-3">
      <MediaThumb item={item} className={THUMB_LG} />
      <div className="min-w-0 flex-1">
        {/* 标题 + 状态 */}
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary" title={item.title}>
            {item.title}
          </p>
          <Badge tone={PIPELINE_ITEM_TONE[item.status] ?? 'neutral'}>{item.status}</Badge>
          {item.is_lowscore && (
            <span className="shrink-0 border border-warning/50 px-1.5 py-0.5 text-[10px] leading-none text-warning">
              {t('console.lowScore')}
            </span>
          )}
        </div>

        {/* 生产方式（v0.3.3）：人工选择加工方案 */}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wide text-text-disabled">{t('console.produce.title')}</span>
          <ProduceOptionsPicker
            value={options}
            compact
            onChange={(next) => setDraft(next)}
          />
          {draft && (
            <>
              <button
                type="button"
                onClick={() => onSaveOptions(item, draft)}
                className="flex items-center gap-1 border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary transition-colors hover:bg-primary/20"
              >
                <Icon name="check" size={10} />
                {t('common.save')}
              </button>
              <button
                type="button"
                onClick={() => setDraft(null)}
                className="px-1 py-0.5 text-[10px] text-text-secondary transition-colors hover:text-text-primary"
              >
                {t('docs.cancel')}
              </button>
            </>
          )}
        </div>

        {/* 下载信息 */}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-text-secondary">
          <Badge tone="neutral">r/{item.subreddit}</Badge>
          <Badge tone="neutral">u/{item.author}</Badge>
          <Badge tone="neutral">r{item.reddit_score}</Badge>
          <span className="flex items-center gap-1 text-[11px]">
            <Icon name={hasRaw ? 'check' : 'grip'} size={11} className={hasRaw ? 'text-success' : 'text-text-disabled'} />
            {hasRaw ? t('console.downloaded') : t('console.pendingDownload')}
          </span>
        </div>

        {/* 评分信息 */}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
          {item.score_total != null ? (
            <>
              <Badge tone="primary">AI {item.score_total.toFixed(1)}</Badge>
              <ScoreDims dims={dims} />
            </>
          ) : (
            <span className="text-[11px] text-text-disabled">{t('console.pendingScore')}</span>
          )}
        </div>

        {/* 制作信息 */}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-text-secondary">
          {hasVideo ? (
            <span className="flex items-center gap-1">
              <Icon name="check" size={11} className="text-success" />
              {t('console.produced')}
            </span>
          ) : (
            <span className="flex items-center gap-1">
              <Icon name="grip" size={11} className="text-text-disabled" />
              {t('console.pendingProduce')}
            </span>
          )}
          {hasCover && <span className="text-text-disabled">· {t('console.hasCover')}</span>}
        </div>
      </div>
    </li>
  )
}
