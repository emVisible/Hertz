import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { PipelineItem } from '../../api'
import { Badge, Button, CopyButton, Icon, Select } from '../ui'
import { MediaThumb, PIPELINE_ITEM_TONE } from './PipelineStage'
import { ScoreDims } from './ScoreDims'
import { ScheduleField } from './ScheduleField'
import { BILI_TIDS, biliTidName } from '../../constants/bilibili'

/** 审核卡片（借鉴 Autarkeia 信息结构，Hertz 设计语言）：
 *  媒体缩略（可播放/换封面）+ 标题内联编辑 + 徽章行 + 评分维度网格 +
 *  文案折叠 + B站标签/分区 Select + 排期 + 通过/驳回（右对齐）。 */
export function AuditCard({
  item,
  onApprove,
  onReject,
  onSaveMeta,
  onUploadCover,
  onReprocess,
}: {
  item: PipelineItem
  onApprove: (item: PipelineItem) => void
  onReject: (item: PipelineItem) => void
  onSaveMeta: (item: PipelineItem, meta: Record<string, string | number | null>) => void
  onUploadCover: (item: PipelineItem, file: File) => void
  onReprocess: (item: PipelineItem, retranslate: boolean) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [titleDraft, setTitleDraft] = useState<string | null>(null)
  const [tagsDraft, setTagsDraft] = useState<string | null>(null)
  const [tidDraft, setTidDraft] = useState<string | null>(null)
  const coverInputRef = useRef<HTMLInputElement>(null)
  const script = item.script_json
  const biliTitle = (script?.bili_title as string | undefined) ?? item.title
  const biliTags = (script?.bili_tags as string | undefined) ?? ''
  const biliTid = script?.bili_tid != null ? String(script.bili_tid) : ''

  return (
    <li className="group flex gap-5 px-4 py-4">
      {/* 媒体区（相册感）：w-1/3 宽度，16:9 圆角卡片 + 柔和阴影 + 留白 */}
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
        {/* 评分维度：独立迷你网格（v0.2.6，不再平铺进 meta 行） */}
        <ScoreDims dims={item.score_dimensions} />
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

        {/* B站分区（tid）：Select 选择（v0.2.6 参考原项目分区表）；
            未手动设置时显示自动建议分区名（v0.2.8，非数字、非误导性「留空」） */}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wide text-text-disabled">{t('console.biliTid')}</span>
          <Select
            aria-label={t('console.biliTid')}
            value={tidDraft ?? biliTid}
            onChange={(e) => setTidDraft(e.target.value)}
            options={[
              {
                value: '',
                label: biliTid
                  ? `${biliTidName(Number(biliTid))} · ${t('console.tidAuto')}`
                  : biliTidName(item.auto_tid)
                    ? `${biliTidName(item.auto_tid)} · ${t('console.tidAuto')}`
                    : t('console.tidAuto'),
              },
              // 自定义 tid 兜底（不在分区表内的显式值不空白）
              ...(biliTid && !BILI_TIDS.some((p) => String(p.tid) === biliTid)
                ? [{ value: biliTid, label: `${biliTid} (自定义)` }]
                : []),
              ...BILI_TIDS.map((p) => ({
                value: String(p.tid),
                label: `${p.tid} · ${p.name}`,
              })),
            ]}
            className="w-36"
          />
          {tidDraft !== null && (
            <Button
              size="sm"
              onClick={() => { onSaveMeta(item, { bili_tid: tidDraft ? Number(tidDraft) : 0 }); setTidDraft(null) }}
            >
              {t('common.save')}
            </Button>
          )}
          {tidDraft !== null && (
            <Button size="sm" variant="ghost" onClick={() => setTidDraft(null)}>
              {t('docs.cancel')}
            </Button>
          )}
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

        {/* 操作区（v0.2.7）：hover/键盘聚焦卡片才显示——通过/驳回 + 重新处理/重新翻译
            （参考原项目 reproduce/retranslate），默认隐藏保持简约（§17.6 可达性：
            focus-within 保证键盘用户可见） */}
        <div className="mt-2 flex items-center justify-end gap-2 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
          <Button size="sm" variant="ghost" onClick={() => onReprocess(item, true)} title={t('console.retranslateHint')}>
            <Icon name="refresh" size={12} />
            {t('console.retranslate')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onReprocess(item, false)} title={t('console.reprocessHint')}>
            <Icon name="refresh" size={12} />
            {t('console.reprocess')}
          </Button>
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
