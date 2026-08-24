import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from '../../i18n'

import type { PipelineItem } from '../../api'
import { useExecutionStore } from '../../stores/execution'
import { Badge, Button, Icon, Menu, Select, type IconName } from '../ui'
import { ITEM_TYPE_BADGE, MediaThumb } from './PipelineStage'
import { ScheduleField } from './ScheduleField'
import { BILI_TIDS, biliTidName } from '../../constants/bilibili'

/** 分发目标（v0.3.4）：逐条覆盖全局配置，为多平台分发铺路 */
export const PUBLISH_TARGETS = [
  { value: '', label: 'default' },
  { value: 'noop', label: 'noop' },
  { value: 'bilibili', label: 'Bilibili' },
  { value: 'export', label: 'plans.exportLabel' },
]

/** 发布卡片（v0.3.4）：发布元数据全集——标题/标签/分区/版权/排期 +
 *  分发目标（逐条覆盖）+ 定时/立即发布（v0.11.5：立即 = now 清排期）。
 *  封面：v0.11.5 随机抽帧按钮（onRandomCover）。 */
export function PublishCard({
  item,
  onPublish,
  onSaveMeta,
  onRequeue,
  onRandomCover,
  onEnqueue,
}: {
  item: PipelineItem
  onPublish: (item: PipelineItem, selfmade: boolean, target: string, now: boolean) => void
  onSaveMeta: (item: PipelineItem, meta: Record<string, string | number | null>) => void
  onRequeue: (item: PipelineItem) => void
  onRandomCover: (item: PipelineItem) => void
  /** 入队/出队（v0.12）：''=出队｜holding=预发布｜ready=发布队列 */
  onEnqueue: (item: PipelineItem, phase: '' | 'holding' | 'ready') => void
}) {
  const { t } = useTranslation()
  // v0.11.3：发布进行中——按钮转圈 + 防重复提交（上传为长任务）
  const busy = useExecutionStore((s) => s.pipeline.busy[item.id])
  const [titleDraft, setTitleDraft] = useState<string | null>(null)
  const [descDraft, setDescDraft] = useState<string | null>(null)
  const [tagsDraft, setTagsDraft] = useState<string | null>(null)
  const [tidDraft, setTidDraft] = useState<string | null>(null)
  const [target, setTarget] = useState<string>(() => (item.publish_json?.target as string | undefined) ?? '')
  // v0.8.9 AXIOM 2.5：草稿态随 item 切换重置（不依赖 key remount 的单点约定——
  // 列表虚拟化/移除 key 时 draft 会串台）
  useEffect(() => {
    setTitleDraft(null)
    setDescDraft(null)
    setTagsDraft(null)
    setTidDraft(null)
    setTarget((item.publish_json?.target as string | undefined) ?? '')
    setAltIdx(-1)
  }, [item.id])
  const script = item.script_json
  const biliTitle = (script?.bili_title as string | undefined) ?? item.title
  const biliDesc = (script?.bili_desc as string | undefined) ?? ''
  const biliTags = (script?.bili_tags as string | undefined) ?? ''
  // v0.15 标题 N 选 1：备选候选（‹›循环切换，直接保存——幂等可切回）
  const titleAlts = (script?.bili_title_alternatives as string[] | undefined) ?? []
  const [altIdx, setAltIdx] = useState<number>(-1)

  function cycleTitle(delta: number) {
    const pool = [biliTitle, ...titleAlts].filter(Boolean)
    if (pool.length < 2) return
    const next = (altIdx + delta + pool.length) % pool.length
    setAltIdx(next)
    onSaveMeta(item, { bili_title: pool[next] })
    setTitleDraft(null)
  }
  const biliTid = script?.bili_tid != null ? String(script.bili_tid) : ''
  // 版权（v0.3.2）：1=自制 / 2=转载，默认转载；发布 selfmade 由开关驱动
  const copyright = script?.bili_copyright != null ? Number(script.bili_copyright) : 2
  const selfmade = copyright === 1
  const scheduled = item.scheduled_at ? item.scheduled_at.slice(0, 16) : null
  const holding = item.queue_phase === 'holding'
  const inQueue = item.queue_phase === 'ready'
  // 摘要-详情（AXIOM 四部·长流程视图）：折叠态一眼看状态，展开态读完整细节。
  // 默认展开判定源自可直接检查的当前状态：未排期且未入队 = 待处理（需要用户动作）。
  const [expanded, setExpanded] = useState<boolean>(
    () => item.scheduled_at == null && item.queue_phase === '',
  )

  function toggleCopyright() {
    onSaveMeta(item, { bili_copyright: selfmade ? 2 : 1 })
  }

  return (
    <li className="group flex gap-5 px-4 py-4">
      {/* 媒体区（相册感，对标审核/预处理卡）：16:9 圆角 + 阴影 + 常驻封面抽帧按钮
       *  （v0.11.9：改为常驻——此前 hover 才浮现，用户找不到随机抽真封面入口） */}
      <div className="group/cover relative aspect-video w-1/3 shrink-0">
        <div className="aspect-video overflow-hidden rounded-lg shadow-sm">
          <MediaThumb item={item} className="h-full w-full" />
        </div>
        <button
          type="button"
          disabled={busy?.action === 'cover'}
          onClick={() => onRandomCover(item)}
          title={t('console.coverRandomHint')}
          className="absolute bottom-1.5 right-1.5 flex h-7 w-7 items-center justify-center rounded-full border border-border bg-black/55 text-white/90 backdrop-blur-sm transition-colors hover:border-primary hover:text-primary disabled:opacity-40"
        >
          <Icon name="refresh" size={13} className={busy?.action === 'cover' ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="min-w-0 flex-1">
        {/* 标题行（对标审核/预处理）：标题 + 类型/状态徽章 + 警示 + 展开箭头 */}
        <div
          role="button"
          tabIndex={0}
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              setExpanded((v) => !v)
            }
          }}
          className="flex cursor-pointer items-start gap-2"
        >
          <p className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary" title={biliTitle}>
            {biliTitle}
          </p>
          {/* 标题候选切换（v0.15 N 选 1）：‹›循环 bili_title + alternatives，点击即保存 */}
          {titleAlts.length > 0 && !titleDraft && (
            <span className="flex shrink-0 items-center gap-0.5 text-text-disabled">
              <button
                type="button"
                disabled={!!busy}
                onClick={(e) => { e.stopPropagation(); cycleTitle(-1) }}
                title={t('console.titlePrevAlt')}
                className="flex h-5 w-5 items-center justify-center rounded-sm transition-colors hover:bg-surface-2 hover:text-primary"
              >
                ‹
              </button>
              <button
                type="button"
                disabled={!!busy}
                onClick={(e) => { e.stopPropagation(); cycleTitle(1) }}
                title={t('console.titleNextAlt')}
                className="flex h-5 w-5 items-center justify-center rounded-sm transition-colors hover:bg-surface-2 hover:text-primary"
              >
                ›
              </button>
            </span>
          )}
          {ITEM_TYPE_BADGE[item.item_type] && (
            <Badge tone={ITEM_TYPE_BADGE[item.item_type].tone}>
              {t(ITEM_TYPE_BADGE[item.item_type].labelKey)}
            </Badge>
          )}
          {/* 单一信号徽章：未排期警示 > 队列相位（AXIOM：一次只给一个关键信号） */}
          {!scheduled && !holding && !inQueue ? (
            <span className="shrink-0 border border-warning/50 px-1.5 py-0.5 text-[10px] leading-none text-warning">
              {t('console.scheduleMissing')}
            </span>
          ) : holding ? (
            <Badge tone="primary">{t('console.phaseHolding')}</Badge>
          ) : inQueue ? (
            <Badge tone="success">{t('console.phaseReady')}</Badge>
          ) : null}
          <Icon
            name="chevron-down"
            size={13}
            className={`mt-0.5 shrink-0 text-text-disabled transition-transform ${expanded ? 'rotate-180' : ''}`}
          />
        </div>
        {/* meta 行 Badge 组（对标审核/预处理）：来源 + AI 分 + 分发目标 + 排期 */}
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
          {item.score_total != null && (
            <Badge tone="primary">AI {item.score_total.toFixed(1)}</Badge>
          )}
          {target !== '' && <Badge tone="neutral">→ {target}</Badge>}
          {scheduled && (
            <span className="font-mono text-[10px] text-text-secondary">
              {new Date(item.scheduled_at!).toLocaleString()}
            </span>
          )}
        </div>

        {/* 展开态：按功能分组两块（对标审核/预处理卡的分组块语言） */}
        {expanded && (
          <div className="mt-2 space-y-2">
            {/* 分组块1「内容」：标题（可编辑）+ 标签 + 简介 */}
            <div className="rounded-md border border-border/60 bg-surface-2/30 p-2">
              <div className="mb-1.5 text-[10px] uppercase tracking-wide text-text-disabled">
                {t('console.groupContent')}
              </div>
              <div className="space-y-1.5">
                {/* 标题（发布元数据，可编辑） */}
                <div className="flex items-center gap-3">
                  <span className="w-14 shrink-0 text-[10px] uppercase tracking-wide text-text-disabled">
                    {t('console.titleLabel')}
                  </span>
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
                        {t('common.cancel')}
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
                </div>

                {/* 标签（可编辑，v0.3.2 自审核卡迁移） */}
                <div className="flex items-start gap-3">
                  <span className="w-14 shrink-0 pt-1 text-[10px] uppercase tracking-wide text-text-disabled">{t('console.biliTags')}</span>
                  {tagsDraft !== null ? (
                    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
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
                        {t('common.cancel')}
                      </Button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setTagsDraft(biliTags)}
                      className="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-left"
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

                {/* 简介（v0.8.5，可编辑）：produce 自动生成中文首句 + 署名 */}
                <div className="flex items-start gap-3">
                  <span className="w-14 shrink-0 pt-1 text-[10px] uppercase tracking-wide text-text-disabled">{t('console.biliDesc')}</span>
                  {descDraft !== null ? (
                    <div className="flex min-w-0 flex-1 items-start gap-1.5">
                      <textarea
                        autoFocus
                        rows={2}
                        value={descDraft}
                        onChange={(e) => setDescDraft(e.target.value)}
                        className="min-w-0 flex-1 border border-border bg-surface-1 px-2 py-1 text-xs text-text-primary outline-none focus:border-primary"
                      />
                      <Button size="sm" onClick={() => { onSaveMeta(item, { bili_desc: descDraft }); setDescDraft(null) }}>
                        {t('common.save')}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setDescDraft(null)}>
                        {t('common.cancel')}
                      </Button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setDescDraft(biliDesc)}
                      className="min-w-0 flex-1 text-left text-xs leading-relaxed text-text-secondary hover:text-primary"
                      title={t('console.editDesc')}
                    >
                      {biliDesc || <span className="text-[10px] text-text-disabled">{t('console.noDesc')}</span>}
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* 分组块2「分发」：分区/目标/版权 并排 + 排期全宽 */}
            <div className="rounded-md border border-border/60 bg-surface-2/30 p-2">
              <div className="mb-1.5 text-[10px] uppercase tracking-wide text-text-disabled">
                {t('console.groupDistribute')}
              </div>
              <div className="grid gap-1.5 md:grid-cols-3">
                {/* 分区 Select（v0.3.2 自审核卡迁移）：未设置显示自动建议 */}
                <div className="flex min-w-0 items-center gap-3">
                  <span className="w-14 shrink-0 text-[10px] uppercase tracking-wide text-text-disabled">{t('console.biliTid')}</span>
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
                        ? [{ value: biliTid, label: `${biliTid} (${t('common.custom')})` }]
                        : []),
                      ...BILI_TIDS.map((p) => ({
                        value: String(p.tid),
                        label: `${p.tid} · ${biliTidName(p.tid, i18n.language === 'en' ? 'en' : 'zh')}`,
                      })),
                    ]}
                    className="w-full min-w-0"
                  />
                  {tidDraft !== null && (
                    <Button size="sm" onClick={() => { onSaveMeta(item, { bili_tid: tidDraft ? Number(tidDraft) : 0 }); setTidDraft(null) }}>
                      {t('common.save')}
                    </Button>
                  )}
                  {tidDraft !== null && (
                    <Button size="sm" variant="ghost" onClick={() => setTidDraft(null)}>
                      {t('common.cancel')}
                    </Button>
                  )}
                </div>

                {/* 分发目标（v0.3.4）：逐条覆盖全局配置，随发布操作生效 */}
                <div className="flex min-w-0 items-center gap-3">
                  <span className="w-14 shrink-0 text-[10px] uppercase tracking-wide text-text-disabled">{t('console.publishTarget')}</span>
                  <Select
                    aria-label={t('console.publishTarget')}
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                    options={PUBLISH_TARGETS.map((p) => ({
                      value: p.value,
                      label: p.value === '' ? t('console.publishTargetDefault') : t(p.label),
                    }))}
                    className="w-full min-w-0"
                  />
                </div>

                {/* 版权（v0.3.2）：自制 / 转载 显式切换——发布 selfmade 由开关驱动 */}
                <div className="flex min-w-0 items-center gap-3">
                  <span className="w-14 shrink-0 text-[10px] uppercase tracking-wide text-text-disabled">{t('console.copyright')}</span>
                  <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
                    <button
                      type="button"
                      onClick={toggleCopyright}
                      className={`flex items-center gap-1 border px-2 py-0.5 text-[10px] transition-colors ${
                        selfmade
                          ? 'border-primary/50 bg-primary/15 text-primary'
                          : 'border-border text-text-secondary hover:border-text-disabled/50'
                      }`}
                      title={selfmade ? t('console.copyrightSelfmadeHint') : t('console.copyrightHint')}
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
                  </span>
                </div>
              </div>

              {/* 排期（发布阶段设置，全宽） */}
              <div className="mt-1.5 flex items-center gap-3">
                <span className="w-14 shrink-0 text-[10px] uppercase tracking-wide text-text-disabled">{t('console.schedule')}</span>
                <ScheduleField scheduledAt={item.scheduled_at} onSave={(v) => onSaveMeta(item, { scheduled_at: v })} showLabel={false} />
              </div>
            </div>
          </div>
        )}

        {/* 操作区（对标审核/预处理卡：hover 浮现渐进披露，右对齐）——
         *  v0.11.9：打回审核独立按钮（对标 AuditCard 操作组）；
         *  分裂主按钮（GitHub Merge ▾ 式）：主按钮一键执行默认路径，▾ 菜单收纳发布变体 */}
        <div className="mt-2 flex items-center justify-end gap-2 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
          <Button
            size="sm"
            variant="ghost"
            disabled={!!busy}
            onClick={() => onRequeue(item)}
            title={t('console.backToReviewHint')}
          >
            <Icon name="rewind" size={12} />
            {t('console.backToReview')}
          </Button>
          <div className="flex items-stretch rounded-md border border-primary bg-primary text-on-primary shadow-sm">
          <Button
            size="sm"
            className="rounded-none rounded-l-md border-0"
            loading={busy?.action === 'publish'}
              disabled={!!busy}
              onClick={() => onPublish(item, selfmade, target, !scheduled || !!holding || !!inQueue)}
              title={
                scheduled && !holding && !inQueue
                  ? t('console.publishTimedHint')
                  : undefined
              }
            >
              <Icon name="send" size={12} />
              {busy?.action === 'publish'
                ? t('console.busy.publish')
                : scheduled && !holding && !inQueue
                  ? t('console.publishTimed')
                  : t('console.publishNow')}
            </Button>
            <Menu
              align="right"
              trigger={(open) => (
                <button
                  type="button"
                  disabled={!!busy}
                  aria-label={t('console.publishMenu')}
                  aria-expanded={open}
                  className={`flex h-7 items-center rounded-r-md border-l border-on-primary/25 px-1.5 text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50`}
                >
                  <Icon name="chevron-down" size={11} />
                </button>
              )}
              items={[
                {
                  label: t('console.publishNow'),
                  icon: 'send',
                  active: !scheduled || !!holding || !!inQueue,
                  onClick: () => onPublish(item, selfmade, target, true),
                },
                {
                  label: t('console.publishTimed'),
                  icon: 'play',
                  active: !!scheduled && !holding && !inQueue,
                  disabled: !scheduled || !!busy,
                  title: !scheduled ? t('console.scheduleFirst') : undefined,
                  onClick: () => onPublish(item, selfmade, target, false),
                },
                'divider',
                ...(item.queue_phase === 'ready'
                  ? [{
                      label: t('console.queueLeaveReady'),
                      icon: 'rewind' as IconName,
                      active: true,
                      disabled: !!busy,
                      onClick: () => onEnqueue(item, ''),
                    }]
                  : [{
                      label: t('console.queueToReady'),
                      icon: 'clock' as IconName,
                      active: false,
                      disabled: !!busy,
                      onClick: () => onEnqueue(item, 'ready'),
                    }]),
                ...(item.queue_phase === 'holding'
                  ? [{
                      label: t('console.queueLeave'),
                      icon: 'library' as IconName,
                      active: true,
                      disabled: !!busy,
                      onClick: () => onEnqueue(item, ''),
                    }]
                  : [{
                      label: t('console.queueToHolding'),
                      icon: 'library' as IconName,
                      active: false,
                      disabled: !!busy,
                      onClick: () => onEnqueue(item, 'holding'),
                    }]),
              ]}
            />
          </div>
        </div>
      </div>
    </li>
  )
}
