import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { PipelineItem } from '../../api'
import { Badge, Button, Icon, Select } from '../ui'
import { MediaThumb, THUMB_LG } from './PipelineStage'
import { ScheduleField } from './ScheduleField'
import { BILI_TIDS, biliTidName } from '../../constants/bilibili'

/** 分发目标（v0.3.4）：逐条覆盖全局配置，为多平台分发铺路 */
export const PUBLISH_TARGETS = [
  { value: '', label: 'default' },
  { value: 'noop', label: 'noop' },
  { value: 'bilibili', label: 'Bilibili' },
  { value: 'export', label: '导出包' },
]

/** 发布卡片（v0.3.4）：发布元数据全集——标题/标签/分区/版权/排期 +
 *  分发目标（逐条覆盖）+ 定时/立即发布。 */
export function PublishCard({
  item,
  onPublish,
  onSaveMeta,
  onRequeue,
}: {
  item: PipelineItem
  onPublish: (item: PipelineItem, selfmade: boolean, target: string) => void
  onSaveMeta: (item: PipelineItem, meta: Record<string, string | number | null>) => void
  onRequeue: (item: PipelineItem) => void
}) {
  const { t } = useTranslation()
  const [titleDraft, setTitleDraft] = useState<string | null>(null)
  const [tagsDraft, setTagsDraft] = useState<string | null>(null)
  const [tidDraft, setTidDraft] = useState<string | null>(null)
  const [target, setTarget] = useState<string>(() => (item.publish_json?.target as string | undefined) ?? '')
  const script = item.script_json
  const biliTitle = (script?.bili_title as string | undefined) ?? item.title
  const biliTags = (script?.bili_tags as string | undefined) ?? ''
  const biliTid = script?.bili_tid != null ? String(script.bili_tid) : ''
  // 版权（v0.3.2）：1=自制 / 2=搬运，默认搬运；发布 selfmade 由开关驱动
  const copyright = script?.bili_copyright != null ? Number(script.bili_copyright) : 2
  const selfmade = copyright === 1
  const scheduled = item.scheduled_at ? item.scheduled_at.slice(0, 16) : null

  function toggleCopyright() {
    onSaveMeta(item, { bili_copyright: selfmade ? 2 : 1 })
  }

  return (
    <li className="flex gap-5 px-4 py-4">
      <MediaThumb item={item} className={THUMB_LG} />
      <div className="min-w-0 flex-1">
        {/* 标题（发布元数据，可编辑） */}
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
          <Badge tone="success">approved</Badge>
        </div>
        <p className="mt-1 truncate text-xs text-text-disabled">
          r/{item.subreddit} · u/{item.author}
          {item.score_total != null && <> · AI {item.score_total.toFixed(1)}</>}
        </p>

        {/* B站标签（可编辑，v0.3.2 自审核卡迁移） */}
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

        {/* 分区 Select（v0.3.2 自审核卡迁移）：未设置显示自动建议 */}
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

        {/* 分发目标（v0.3.4）：逐条覆盖全局配置，随发布操作生效 */}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wide text-text-disabled">{t('console.publishTarget')}</span>
          <Select
            aria-label={t('console.publishTarget')}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            options={PUBLISH_TARGETS.map((p) => ({
              value: p.value,
              label: p.value === '' ? t('console.publishTargetDefault') : p.label,
            }))}
            className="w-32"
          />
        </div>

        {/* 版权（v0.3.2）：自制 / 搬运 显式切换——发布 selfmade 由开关驱动 */}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wide text-text-disabled">{t('console.copyright')}</span>
          <button
            type="button"
            onClick={toggleCopyright}
            className={`flex items-center gap-1 border px-2 py-0.5 text-[10px] transition-colors ${
              selfmade
                ? 'border-primary/50 bg-primary/15 text-primary'
                : 'border-border text-text-secondary hover:border-text-disabled/50'
            }`}
            title={t('console.copyrightHint')}
          >
            {t('console.copyrightSelfmade')}
          </button>
          <button
            type="button"
            onClick={toggleCopyright}
            className={`flex items-center gap-1 border px-2 py-0.5 text-[10px] transition-colors ${
              !selfmade
                ? 'border-primary/50 bg-primary/15 text-primary'
                : 'border-border text-text-secondary hover:border-text-disabled/50'
            }`}
            title={t('console.copyrightHint')}
          >
            {t('console.copyrightRepost')}
          </button>
          {selfmade && (
            <span className="text-[10px] text-text-disabled">{t('console.copyrightSelfmadeHint')}</span>
          )}
        </div>

        {/* 排期（发布阶段设置） */}
        <div className="mt-1.5">
          <ScheduleField
            scheduledAt={item.scheduled_at}
            onSave={(v) => onSaveMeta(item, { scheduled_at: v })}
          />
        </div>

        {/* 发布操作：定时（需排期）/ 立即（版权开关决定自制，分发目标逐条生效） */}
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={!scheduled}
            title={!scheduled ? t('console.scheduleFirst') : undefined}
            onClick={() => onPublish(item, selfmade, target)}
          >
            <Icon name="play" size={12} />
            {t('console.publishTimed')}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => onPublish(item, selfmade, target)}>
            <Icon name="send" size={12} />
            {t('console.publishNow')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onRequeue(item)}>
            {t('console.backToReview')}
          </Button>
        </div>
      </div>
    </li>
  )
}
