import { useTranslation } from 'react-i18next'

import type { PipelineItem } from '../../api'
import { Badge, Icon } from '../ui'
import { MediaThumb, PIPELINE_ITEM_TONE, THUMB_LG } from './PipelineStage'
import { ScoreDims } from './ScoreDims'

/** 预处理卡片（v0.2.0）：单条数据在审核前的完整状态——
 *  下载信息（来源/素材是否已下载）+ 评分信息（AI 分数与维度）+ 制作信息（产物状态）。
 *  纯展示，操作收敛在审核/发布。 */
export function PreReviewCard({ item }: { item: PipelineItem }) {
  const { t } = useTranslation()
  const dims = item.score_dimensions
  const hasRaw = !!item.raw_path
  const hasVideo = !!item.video_path
  const hasCover = !!item.cover_path

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
