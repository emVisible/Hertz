import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { PipelineItem } from '../../api'
import { Badge, Button, CopyButton, Icon } from '../ui'
import { MediaThumb, PIPELINE_ITEM_TONE, THUMB_LG } from './PipelineStage'
import { ScoreDims } from './ScoreDims'
import { ScheduleField } from './ScheduleField'

/** 审核卡片（借鉴 Autarkeia 信息结构，Hertz 设计语言）：
 *  媒体缩略 + 标题内联编辑 + 徽章行 + 评分维度 chips + 文案折叠 + B站标签 +
 *  排期设置 + 通过/驳回（右对齐）。 */
export function AuditCard({
  item,
  onApprove,
  onReject,
  onSaveMeta,
}: {
  item: PipelineItem
  onApprove: (item: PipelineItem) => void
  onReject: (item: PipelineItem) => void
  onSaveMeta: (item: PipelineItem, meta: Record<string, string | number | null>) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [titleDraft, setTitleDraft] = useState<string | null>(null)
  const [tagsDraft, setTagsDraft] = useState<string | null>(null)
  const script = item.script_json
  const biliTitle = (script?.bili_title as string | undefined) ?? item.title
  const biliTags = (script?.bili_tags as string | undefined) ?? ''

  return (
    <li className="flex gap-3 px-3 py-3">
      <MediaThumb item={item} className={THUMB_LG} />
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          {titleDraft !== null ? (
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <input
                autoFocus
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                className="h-7 min-w-0 flex-1 border border-border bg-surface-1 px-2 text-sm text-text-primary outline-none focus:border-primary"
              />
              <Button size="sm" onClick={() => { onSaveMeta(item, { bili_title: titleDraft }); setTitleDraft(null) }}>
                {t('common.save')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setTitleDraft(null)}>
                {t('docs.cancel')}
              </Button>
            </div>
          ) : (
            <p
              className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary hover:text-primary"
              title={biliTitle}
              onDoubleClick={() => setTitleDraft(biliTitle)}
            >
              {biliTitle}
            </p>
          )}
          <Badge tone={PIPELINE_ITEM_TONE[item.status] ?? 'neutral'}>{item.status}</Badge>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-text-secondary">
          <Badge tone="neutral">r/{item.subreddit}</Badge>
          <Badge tone="neutral">u/{item.author}</Badge>
          <Badge tone="neutral">r{item.reddit_score}</Badge>
          {item.score_total != null && <Badge tone="primary">AI {item.score_total.toFixed(1)}</Badge>}
          {item.is_lowscore && (
            <span className="border border-warning/50 px-1.5 py-0.5 text-[10px] leading-none text-warning">
              {t('console.lowScore')}
            </span>
          )}
          <ScoreDims dims={item.score_dimensions} />
          {item.source_url && (
            <a
              href={item.source_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline-offset-2 hover:underline"
            >
              {t('console.originalLink')}
            </a>
          )}
        </div>
        {item.error && <p className="mt-1 text-xs text-error">{item.error}</p>}

        {/* B站标签（可编辑） */}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wide text-text-disabled">{t('console.biliTags')}</span>
          {tagsDraft !== null ? (
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              <input
                autoFocus
                value={tagsDraft}
                onChange={(e) => setTagsDraft(e.target.value)}
                placeholder={t('console.tagsPlaceholder')}
                className="h-7 min-w-0 flex-1 border border-border bg-surface-1 px-2 text-xs text-text-primary outline-none focus:border-primary"
              />
              <Button size="sm" onClick={() => { onSaveMeta(item, { bili_tags: tagsDraft }); setTagsDraft(null) }}>
                {t('common.save')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setTagsDraft(null)}>
                {t('docs.cancel')}
              </Button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setTagsDraft(biliTags)}
              className="flex flex-wrap items-center gap-1 text-left"
              title={t('console.editTags')}
            >
              {biliTags
                ? biliTags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean).map((tag) => (
                    <span key={tag} className="border border-border px-1.5 py-0.5 text-[10px] text-text-secondary">
                      {tag}
                    </span>
                  ))
                : <span className="text-[10px] text-text-disabled">{t('console.noTags')}</span>}
            </button>
          )}
        </div>

        {/* 排期设置 */}
        <div className="mt-1.5">
          <ScheduleField
            scheduledAt={item.scheduled_at}
            onSave={(v) => onSaveMeta(item, { scheduled_at: v })}
          />
        </div>

        {script && (
          <details className="mt-2" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
            <summary
              className="cursor-pointer select-none text-xs text-text-secondary hover:text-text-primary"
              aria-label={`${t('console.script')}: ${item.title}`}
            >
              {t('console.script')}
            </summary>
            <div className="relative mt-1 border border-border bg-surface-2/50">
              <CopyButton text={String(script.script ?? '')} className="absolute right-1.5 top-1.5" />
              <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap p-2 pr-9 font-mono text-[11px] leading-relaxed text-text-primary">
                {String(script.script ?? '—')}
              </pre>
            </div>
          </details>
        )}

        {/* 通过/驳回：右侧对齐，等宽按钮（审核 menu 只含 queued 条目） */}
        <div className="mt-2 flex items-center justify-end gap-2">
          <Button size="sm" className="w-20" onClick={() => onApprove(item)}>
            <Icon name="check" size={12} />
            {t('console.approve')}
          </Button>
          <Button size="sm" variant="danger" className="w-20" onClick={() => onReject(item)}>
            <Icon name="close" size={12} />
            {t('console.reject')}
          </Button>
        </div>
      </div>
    </li>
  )
}
