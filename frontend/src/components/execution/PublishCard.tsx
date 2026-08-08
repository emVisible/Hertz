import { useTranslation } from 'react-i18next'

import type { PipelineItem } from '../../api'
import { Badge, Button, Icon } from '../ui'
import { MediaThumb, THUMB_LG } from './PipelineStage'
import { ScheduleField } from './ScheduleField'

/** 发布卡片（独立人工环节，v5.10）：approved 条目 + 排期 + 定时/立即/自制发布。 */
export function PublishCard({
  item,
  onPublish,
  onSaveMeta,
  onRequeue,
}: {
  item: PipelineItem
  onPublish: (item: PipelineItem, selfmade: boolean) => void
  onSaveMeta: (item: PipelineItem, meta: Record<string, string | number | null>) => void
  onRequeue: (item: PipelineItem) => void
}) {
  const { t } = useTranslation()
  const script = item.script_json
  const biliTitle = (script?.bili_title as string | undefined) ?? item.title
  const scheduled = item.scheduled_at ? item.scheduled_at.slice(0, 16) : null

  return (
    <li className="flex gap-3 px-3 py-3">
      <MediaThumb item={item} className={THUMB_LG} />
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary" title={biliTitle}>
            {biliTitle}
          </p>
          <Badge tone="success">approved</Badge>
        </div>
        <p className="mt-1 truncate text-xs text-text-disabled">
          r/{item.subreddit} · u/{item.author}
          {item.score_total != null && <> · AI {item.score_total.toFixed(1)}</>}
        </p>

        {/* 排期 */}
        <div className="mt-2">
          <ScheduleField
            scheduledAt={item.scheduled_at}
            onSave={(v) => onSaveMeta(item, { scheduled_at: v })}
          />
        </div>

        {/* 发布操作（参考原项目：定时开播 / 立刻开播 / 自制发布） */}
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={!scheduled}
            title={!scheduled ? t('console.scheduleFirst') : undefined}
            onClick={() => onPublish(item, false)}
          >
            <Icon name="play" size={12} />
            {t('console.publishTimed')}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => onPublish(item, false)}>
            <Icon name="send" size={12} />
            {t('console.publishNow')}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => onPublish(item, true)} title={t('console.publishSelfmadeHint')}>
            <Icon name="pen" size={12} />
            {t('console.publishSelfmade')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onRequeue(item)}>
            {t('console.backToReview')}
          </Button>
        </div>
      </div>
    </li>
  )
}
