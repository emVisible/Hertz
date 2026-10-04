import { useTranslation } from 'react-i18next'

import type { ReactNode } from 'react'

import type { PipelineItem } from '../../api'
import { useExecutionStore } from '../../stores/execution'
import { Badge, Button, Icon } from '../ui'
import { ITEM_TYPE_BADGE, MediaThumb, PIPELINE_ITEM_TONE } from './PipelineStage'

/** 预处理紧凑行（v0.8.9 三阶段差异化）：未评分/已评分子菜单用——
 *  大量条目时列表式浏览（信息密度优先），卡式仅保留给已下载未加工
 *  （生产方式选择需要空间）。按阶段显示差异字段：
 *  - 未评分：标题 + 来源 + reddit 分（评分决策输入）
 *  - 已评分：额外醒目 AI 分 + upvote 比率（是否下载的决策输入） */
export function PreReviewRow({
  item,
  stage,
  onScore,
  onDownload,
  onDownloadDirect,
  onReject,
  pick,
}: {
  item: PipelineItem
  stage: 'discovered' | 'scored'
  onScore: (item: PipelineItem) => void
  onDownload: (item: PipelineItem) => void
  /** 直下（v0.11.10）：未评分条目绕过评分直接下载——省 API 余额场景 */
  onDownloadDirect?: (item: PipelineItem) => void
  onReject: (item: PipelineItem) => void
  /** 「捞入今日」（v0.34 D-218）：由列表侧决定的入口，卡片自己不发起写（`TodayPick`） */
  pick?: ReactNode
}) {
  const { t } = useTranslation()
  // v0.11.3：单条操作进行中——按钮转圈 + 防重复提交
  const busy = useExecutionStore((s) => s.pipeline.busy[item.id])

  return (
    <li className="group flex items-center gap-3 px-4 py-2 transition-colors hover:bg-surface-2/40">
      {/* 小缩略图 */}
      <div className="h-12 w-20 shrink-0 overflow-hidden rounded-sm bg-surface-2">
        <MediaThumb item={item} className="h-full w-full" />
      </div>

      {/* 标题 + meta */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <p className="min-w-0 flex-1 truncate text-sm text-text-primary" title={item.title}>
            {item.title}
          </p>
          {ITEM_TYPE_BADGE[item.item_type] && (
            <Badge tone={ITEM_TYPE_BADGE[item.item_type].tone}>
              {t(ITEM_TYPE_BADGE[item.item_type].labelKey)}
            </Badge>
          )}
          <Badge tone={PIPELINE_ITEM_TONE[item.status] ?? 'neutral'}>{item.status}</Badge>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-text-secondary">
          <span className="border border-border px-1 py-px text-[10px]">r/{item.subreddit}</span>
          <span>r{item.reddit_score}</span>
          {item.upvote_ratio > 0 && (
            <span className={item.upvote_ratio >= 0.85 ? '' : 'text-warning'}>
              {Math.round(item.upvote_ratio * 100)}%↑
            </span>
          )}
          {item.is_lowscore && (
            <span className="border border-warning/50 px-1 py-px text-[10px] text-warning">
              {t('console.lowScore')}
            </span>
          )}
        </div>
      </div>

      {/* 分数（已评分醒目）：下载决策的核心输入 */}
      {stage === 'scored' && item.score_total != null && (
        <span className="shrink-0 rounded-md bg-primary/10 px-2.5 py-1 text-base font-semibold leading-none text-primary">
          {item.score_total.toFixed(1)}
        </span>
      )}

      {/* 操作：按阶段主操作 + hover 拒绝 */}
      <span className="flex shrink-0 items-center gap-1.5">
        {pick}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onReject(item)}
          title={t('console.reject')}
          className="opacity-0 transition-opacity group-hover:opacity-100"
        >
          <Icon name="close" size={12} />
        </Button>
        {stage === 'discovered' && (
          <>
            {onDownloadDirect && (
              <Button
                size="sm"
                variant="ghost"
                loading={!!busy}
                disabled={!!busy}
                onClick={() => onDownloadDirect(item)}
                title={t('console.downloadUnscoredHint')}
              >
                <Icon name="downloads" size={12} />
                {busy ? t('console.busy.download') : t('console.downloadUnscored')}
              </Button>
            )}
            <Button
              size="sm"
              variant="secondary"
              loading={!!busy}
              disabled={!!busy}
              onClick={() => onScore(item)}
              title={t('console.scoreHint')}
            >
              <Icon name="whisper" size={12} />
              {busy ? t('console.busy.score') : t('console.score')}
            </Button>
          </>
        )}
        {stage === 'scored' && (
          <Button
            size="sm"
            variant="secondary"
            loading={!!busy}
            disabled={!!busy}
            onClick={() => onDownload(item)}
            title={t('console.downloadHint')}
          >
            <Icon name="downloads" size={12} />
            {busy ? t('console.busy.download') : t('console.downloadOne')}
          </Button>
        )}
      </span>
    </li>
  )
}
