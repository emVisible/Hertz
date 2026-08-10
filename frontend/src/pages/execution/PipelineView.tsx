import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { PipelineItem } from '../../api'
import {
  Badge,
  Button,
  Icon,
  QueryErrorState,
  Select,
  TabBar,
} from '../../components/ui'
import {
  AuditCard,
  PIPELINE_ITEM_TONE,
  PipelineStage,
  PreReviewCard,
  PublishCard,
  SectionCard,
  StageItemRow,
  StageList,
} from '../../components/execution'
import { CalendarView } from './CalendarView'
import { ProduceBatchModal } from '../../components/execution/ProduceBatchModal'
import { usePipelineExecution } from '../../hooks/usePipelineExecution'
import { useModelSwitch } from '../../hooks/useModelSwitch'

// ================= Pipeline 域 =================

interface PipelineViewProps {
  step: string
  setStep: (v: string) => void
  limit: number
  setLimit: (v: number) => void
  steps: string[]
  running: boolean
  statusJob: string
  counts: Record<string, number>
  stageError: boolean
  refetchStage: () => void
  stageDiscovered: ReturnType<typeof usePipelineExecution>['stageDiscovered']
  stageDownloaded: ReturnType<typeof usePipelineExecution>['stageDownloaded']
  stageScored: ReturnType<typeof usePipelineExecution>['stageScored']
  stageQueued: ReturnType<typeof usePipelineExecution>['stageQueued']
  stageApproved: ReturnType<typeof usePipelineExecution>['stageApproved']
  stageFailed: ReturnType<typeof usePipelineExecution>['stageFailed']
  stageRejected: ReturnType<typeof usePipelineExecution>['stageRejected']
  stagePublished: ReturnType<typeof usePipelineExecution>['stagePublished']
  tab: string
  setTab: (v: string) => void
  jobs: ReturnType<typeof usePipelineExecution>['jobs']
  sources: ReturnType<typeof usePipelineExecution>['sources']
  failures: Record<string, number>
  supplyWarnings: string[]
  logs: ReturnType<typeof usePipelineExecution>['logs']
  run: () => void
  stop: () => void
  act: (item: PipelineItem, action: 'approve' | 'reject' | 'retry' | 'requeue') => void
  saveMeta: (item: PipelineItem, meta: Record<string, string | number | null>) => Promise<void>
  publishItem: (item: PipelineItem, selfmade?: boolean, target?: string) => void
  uploadCover: (item: PipelineItem, file: File) => void
  retryClass: (cls: string, n: number) => void
  reprocess: (item: PipelineItem, retranslate: boolean) => void
  rescheduleExpired: () => Promise<void>
  setProduceOptions: (items: PipelineItem[], options: Record<string, boolean>) => Promise<void>
  produceOne: (item: PipelineItem) => Promise<void>
  produceBatch: () => Promise<void>
  collectAndDownload: () => Promise<void>
  scoreOne: (item: PipelineItem) => Promise<void>
  scoreBatch: () => Promise<void>
  runStep: (stepName: string) => Promise<void>
  modelSwitch: ReturnType<typeof useModelSwitch>
}

type PipelineTabId = 'run' | 'preReview' | 'inReview' | 'postReview' | 'exceptions'

/** 审核排序（v0.2.6）：前端排序——队列数据已全量拉取，无需后端参数。
 *  videoFirst = 有成片的排前面（可预览优先，默认）；random = 每次洗牌。 */
type AuditSort = 'videoFirst' | 'newest' | 'oldest' | 'scoreDesc' | 'scoreAsc' | 'redditDesc' | 'title' | 'random'
const AUDIT_SORTS: Array<{ id: AuditSort }> = [
  { id: 'videoFirst' },
  { id: 'random' },
  { id: 'newest' },
  { id: 'oldest' },
  { id: 'scoreDesc' },
  { id: 'scoreAsc' },
  { id: 'redditDesc' },
  { id: 'title' },
]

// 第三级路由：内容流水线平铺菜单（v0.2.0 审核三态）——
// 采集（collect+download 手动，下载后自动评分）｜预处理（生产方式选择+制作）
// ｜审核（内容判断）｜发布（分发）｜异常（独立恢复区）
const PIPELINE_TABS = [
  { id: 'run', labelKey: 'console.stageCollect' },
  { id: 'preReview', labelKey: 'console.stagePreReview', countKeys: ['discovered', 'downloaded', 'scored'] },
  { id: 'inReview', labelKey: 'console.stageAudit', countKeys: ['queued'] },
  { id: 'postReview', labelKey: 'console.stagePublish', countKeys: ['approved', 'published'] },
  { id: 'exceptions', labelKey: 'console.stageExceptions', countKeys: ['failed', 'rejected'] },
] satisfies Array<{
  id: PipelineTabId
  labelKey: string
  countKeys?: string[]
}>

/** 预处理排序（v0.3.5）：下载时间（seq 入库序）/ 评分 / 生产方式 */
type PreSort = 'seq' | 'score' | 'produce'
const PRE_SORTS: Array<{ id: PreSort }> = [
  { id: 'seq' },
  { id: 'score' },
  { id: 'produce' },
]

export function PipelineView(p: PipelineViewProps) {
  const { t } = useTranslation()
  // 发布 tab 视图：列表（默认）｜内容日历（v0.2.3）
  const [calendarView, setCalendarView] = useState(false)
  // 批量生产方式（v0.3.3，预处理）
  const [produceBatchOpen, setProduceBatchOpen] = useState(false)
  // 预处理排序（v0.3.5）
  const [preSort, setPreSort] = useState<PreSort>('seq')
  const sortedPreReview = useMemo(() => {
    const list = [...p.stageDownloaded, ...p.stageScored]
    const seqOf = (item: PipelineItem) => item.seq ?? (item.created_at ? Date.parse(item.created_at) : 0)
    switch (preSort) {
      case 'score':
        return list.sort((a, b) => (b.score_total ?? -1) - (a.score_total ?? -1))
      case 'produce': {
        // 生产方式组合排序：直发优先展示（无需加工最快），其余按模块数
        const key = (i: PipelineItem): number => {
          const o = i.produce_options ?? {}
          if ((o as { passthrough?: boolean }).passthrough) return 0
          return Object.values(o).filter(Boolean).length
        }
        return list.sort((a, b) => key(a) - key(b) || -seqOf(a) + seqOf(b))
      }
      default:
        return list.sort((a, b) => seqOf(a) - seqOf(b))
    }
  }, [p.stageDownloaded, p.stageScored, preSort])
  // 审核排序（v0.2.6）：默认「有成片优先」（可预览的在前面）；随机=每次点击重新洗牌
  const [auditSort, setAuditSort] = useState<AuditSort>('videoFirst')
  const [randomSeed, setRandomSeed] = useState(0)
  function changeAuditSort(value: string) {
    if (value === 'random') {
      // 每次选「随机」重新洗牌（seed 变化触发 memo 重排）
      setRandomSeed(Date.now())
    }
    setAuditSort(value as AuditSort)
  }
  const sortedQueued = useMemo(() => {
    const list = [...p.stageQueued]
    // 入库顺序（v0.3.1）：seq 自增序号优先（同批 created_at 相同无法区分先后），
    // 旧数据无 seq 时回退 created_at 时间戳
    const seqOf = (item: PipelineItem) => item.seq ?? (item.created_at ? Date.parse(item.created_at) : 0)
    const cmpSeq = (a: PipelineItem, b: PipelineItem) => seqOf(a) - seqOf(b)
    switch (auditSort) {
      case 'random': {
        // 每次点击「随机」生成一次洗牌（seed 变化触发重排），而非每帧重排
        const shuffled = [...list]
        for (let i = shuffled.length - 1; i > 0; i -= 1) {
          const j = Math.floor(Math.random() * (i + 1))
          ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
        }
        return shuffled
      }
      case 'oldest':
        return list.sort(cmpSeq)
      case 'scoreDesc':
        return list.sort((a, b) => (b.score_total ?? -1) - (a.score_total ?? -1))
      case 'scoreAsc':
        // 低分优先审（低分可复用，人工决定）
        return list.sort((a, b) => (a.score_total ?? 99) - (b.score_total ?? 99))
      case 'redditDesc':
        return list.sort((a, b) => b.reddit_score - a.reddit_score)
      case 'title':
        return list.sort((a, b) => a.title.localeCompare(b.title, 'zh'))
      case 'newest':
        return list.sort((a, b) => -cmpSeq(a, b))
      default:
        return list.sort((a, b) => {
          const av = a.video_path ? 1 : 0
          const bv = b.video_path ? 1 : 0
          return bv - av || -cmpSeq(a, b)
        })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.stageQueued, auditSort, randomSeed])
  const pTab: PipelineTabId = PIPELINE_TABS.some((tb) => tb.id === p.tab)
    ? (p.tab as PipelineTabId)
    : 'inReview'

  // 进入审核自动维护排期（v0.2.7）：过期重排 + 未排期自动分配。
  // 会话内只触发一次（v0.2.8）——切 tab 往返不再重复分配，避免排期越排越远
  const rescheduleRef = useRef(false)
  useEffect(() => {
    if (pTab === 'inReview' && !rescheduleRef.current) {
      rescheduleRef.current = true
      void p.rescheduleExpired()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pTab])

  const tabItems = PIPELINE_TABS.map((tb) => ({
    id: tb.id,
    label: t(tb.labelKey),
    // 异常 menu 与正常流程分隔（v0.2.7，最右侧独立区）
    dividerBefore: tb.id === 'exceptions',
    count: tb.countKeys
      ? tb.countKeys.reduce((sum, k) => sum + (p.counts[k] ?? 0), 0)
      : undefined,
  }))

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 平铺菜单栏（第三级路由）：TabBar 统一语言 */}
      <div className="shrink-0 border-b border-border px-4">
        <TabBar items={tabItems} active={pTab} onChange={p.setTab} />
      </div>

      {/* 内容区（当前部分，独立滚动）；key 化触发切换淡入（v0.2.6 消除抖动观感） */}
      <div key={pTab} className="hz-fade-in min-h-0 flex-1 overflow-y-auto">
        {pTab === 'run' && (
          <div className="flex min-h-full flex-col gap-4 p-4">
            {/* 操作区（v0.3.5）：三个显式大按钮——采集/下载/一键，无 Select */}
            <SectionCard title={t('console.stageCollect')} padded={false}>
              <div className="flex flex-wrap items-end gap-3 p-3">
                <Button
                  size="md"
                  onClick={() => void p.runStep('collect')}
                  disabled={p.running}
                  title={t('console.collectHint')}
                >
                  <Icon name="downloads" size={14} />
                  {t('console.stageCollect')}
                </Button>
                <Button
                  size="md"
                  variant="secondary"
                  onClick={() => void p.runStep('download')}
                  disabled={p.running}
                  title={t('console.downloadHint')}
                >
                  <Icon name="downloads" size={14} />
                  {t('console.stageDownload')}
                  <span className="font-mono text-[10px] text-text-disabled">{p.counts.discovered ?? 0}</span>
                </Button>
                <Button
                  size="md"
                  variant="ghost"
                  onClick={() => void p.collectAndDownload()}
                  disabled={p.running}
                  title={t('console.collectAllHint')}
                >
                  <Icon name="play" size={14} />
                  {t('console.collectAll')}
                </Button>
                <Select
                  label={t('console.limit')}
                  value={String(p.limit)}
                  onChange={(e) => p.setLimit(Number(e.target.value))}
                  options={[5, 10, 25, 50].map((n) => ({ value: String(n), label: String(n) }))}
                  className="w-28"
                />
                {p.running && (
                  <p className="pb-1 text-xs text-text-secondary">{p.statusJob}</p>
                )}
              </div>
            </SectionCard>

            {/* 待下载队列（v0.3.5）：discovered 条目——下载前的供给可见 */}
            <SectionCard
              title={`${t('console.pendingDownloads')} (${p.counts.discovered ?? 0})`}
              padded={false}
              className="shrink-0"
            >
              {p.stageDiscovered.length === 0 ? (
                <p className="p-3 text-sm text-text-disabled">{t('console.noPendingDownloads')}</p>
              ) : (
                <ul className="max-h-56 space-y-1 overflow-y-auto p-2">
                  {p.stageDiscovered.map((item) => (
                    <li key={item.id} className="flex items-center gap-2 px-1.5 py-1 text-xs">
                      <span className="min-w-0 flex-1 truncate text-text-secondary" title={item.title}>
                        {item.title}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] text-text-disabled">r{item.reddit_score}</span>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>

            {/* 采集源状态（参考原项目漏斗水位） */}
            <SectionCard title={t('console.sources')} padded={false} className="shrink-0">
              <ul className="max-h-40 space-y-1 overflow-y-auto p-3 text-xs">
                {p.sources.length === 0 && <p className="text-text-disabled">{t('console.noSources')}</p>}
                {p.sources.map((s) => (
                  <li key={`${s.source}:${s.channel}`} className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span
                        title={t(`console.sourceHealth.${s.health}`)}
                        className={`h-2 w-2 shrink-0 rounded-full ${
                          s.health === 'healthy'
                            ? 'bg-emerald-400'
                            : s.health === 'degraded'
                              ? 'bg-warning'
                              : 'bg-error'
                        }`}
                      />
                      <span className="truncate">{s.source}:{s.channel}</span>
                    </span>
                    <span
                      className="shrink-0 text-text-secondary"
                      title={s.last_error ?? undefined}
                    >
                      ok {s.ok_count} / fail {s.fail_count}
                    </span>
                  </li>
                ))}
              </ul>
            </SectionCard>
          </div>
        )}

        {pTab === 'preReview' && (
          <div className="p-4">
            <PipelineStage
              title={t('console.stagePreReview')}
              right={
                <div className="flex items-center gap-1.5">
                  {/* 预处理排序（v0.3.5）：下载时间/评分/生产方式 */}
                  <Select
                    aria-label={t('console.preSort')}
                    value={preSort}
                    onChange={(e) => setPreSort(e.target.value as PreSort)}
                    options={PRE_SORTS.map((s) => ({ value: s.id, label: t(`console.preSort.${s.id}`) }))}
                    className="w-32"
                  />
                  <Button
                    size="sm"
                    onClick={() => void p.scoreBatch()}
                    title={t('console.scoreBatchHint')}
                  >
                    <Icon name="whisper" size={12} />
                    {t('console.scoreBatch')}
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => void p.produceBatch()}
                    title={t('console.produce.batchProduceHint')}
                  >
                    <Icon name="play" size={12} />
                    {t('console.produce.batchProduce')}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setProduceBatchOpen(true)}
                    title={t('console.produce.batchHint')}
                  >
                    <Icon name="config" size={12} />
                    {t('console.produce.batch')}
                  </Button>
                </div>
              }
            >
              {/* v0.3.5：预处理只含已下载/已评分条目（discovered 留在采集 menu 待下载队列） */}
              <StageList
                items={sortedPreReview}
                emptyText={t('console.emptyPreReview')}
                total={(p.counts.downloaded ?? 0) + (p.counts.scored ?? 0)}
                renderRow={(item) => (
                  <PreReviewCard
                    key={item.id}
                    item={item}
                    onSaveOptions={(i, options) => void p.setProduceOptions([i], options)}
                    onScore={(i) => void p.scoreOne(i)}
                    onProduce={(i) => void p.produceOne(i)}
                    onReject={(i) => void p.act(i, 'reject')}
                    onUploadCover={(i, file) => void p.uploadCover(i, file)}
                  />
                )}
              />
            </PipelineStage>
            <ProduceBatchModal
              open={produceBatchOpen}
              onClose={() => setProduceBatchOpen(false)}
              items={[...p.stageDownloaded, ...p.stageScored]}
              onApply={(items, options) => void p.setProduceOptions(items, options)}
            />
          </div>
        )}
        {pTab === 'inReview' && (
          /* 审核专注审核（v0.2.6）：异常内容移至独立「异常」menu——全宽单栏 */
          <div className="p-4">
            <PipelineStage
              title={t('console.stageAudit')}
              isEmpty={p.stageQueued.length === 0}
              emptyText={t('console.emptyAudit')}
              right={
                <Select
                  aria-label={t('console.auditSort')}
                  value={auditSort}
                  onChange={(e) => changeAuditSort(e.target.value)}
                  options={AUDIT_SORTS.map((s) => ({ value: s.id, label: t(`console.auditSort.${s.id}`) }))}
                  className="w-36"
                />
              }
            >
              <ul className="divide-y divide-border/60">
                {sortedQueued.map((item) => (
                    <AuditCard
                      key={item.id}
                      item={item}
                      onApprove={(i) => void p.act(i, 'approve')}
                      onReject={(i) => void p.act(i, 'reject')}
                      onUploadCover={(i, file) => void p.uploadCover(i, file)}
                      onReprocess={(i, retranslate) => void p.reprocess(i, retranslate)}
                    />
                ))}
              </ul>
            </PipelineStage>
          </div>
        )}

        {/* 异常（独立 menu，v0.2.6）：失败分类看板 + 批量重试 + 恢复待审 */}
        {pTab === 'exceptions' && (
          <div className="p-4">
            <SectionCard title={t('console.exceptions')} padded={false}>
              {p.stageError ? (
                <QueryErrorState message={t('error.queryFailed', { detail: 'pipeline' })} onRetry={() => void p.refetchStage()} />
              ) : p.stageFailed.length + p.stageRejected.length === 0 ? (
                <p className="p-3 text-sm text-text-disabled">{t('console.noExceptions')}</p>
              ) : (
                <>
                  {/* 失败分类看板（v0.2.1）：按类统计 + 同类批量重试 */}
                  {Object.keys(p.failures).length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5 border-b border-border/60 px-3 py-2">
                      {Object.entries(p.failures).map(([cls, n]) => (
                        <span key={cls} className="inline-flex items-center gap-1.5 border border-border bg-surface-2/60 px-2 py-0.5 text-[11px] text-text-secondary">
                          <span className="font-mono">{cls}</span>
                          <span className="text-text-disabled">{n}</span>
                          <button
                            type="button"
                            onClick={() => void p.retryClass(cls, n)}
                            title={t('console.retryClassHint', { cls })}
                            className=" p-0.5 text-text-disabled transition-colors hover:text-primary"
                          >
                            <Icon name="refresh" size={11} />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  <StageList
                    items={[...p.stageRejected, ...p.stageFailed]}
                    emptyText={t('console.noExceptions')}
                    total={(p.counts.rejected ?? 0) + (p.counts.failed ?? 0)}
                    renderRow={(item) => (
                      <StageItemRow
                        item={item}
                        badge={<Badge tone={PIPELINE_ITEM_TONE[item.status] ?? 'neutral'}>{item.status}</Badge>}
                        right={
                          item.status === 'failed' ? (
                            <Button size="sm" variant="ghost" onClick={() => void p.act(item, 'retry')}>
                              {t('common.retry')}
                            </Button>
                          ) : (
                            <Button size="sm" variant="ghost" onClick={() => void p.act(item, 'requeue')}>
                              {t('console.restore')}
                            </Button>
                          )
                        }
                      />
                    )}
                  />
                </>
              )}
            </SectionCard>
          </div>
        )}

        {pTab === 'postReview' && (
          <div className="flex flex-col gap-4 p-4">
            {/* 视图切换：列表（默认）｜内容日历（v0.2.3，Buffer/新榜同款） */}
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setCalendarView(false)}
                className={`px-2.5 py-1 text-xs transition-colors ${
                  !calendarView
                    ? 'bg-surface-2 font-medium text-text-primary'
                    : 'text-text-secondary hover:bg-surface-2/60'
                }`}
              >
                {t('console.calendarList')}
              </button>
              <button
                type="button"
                onClick={() => setCalendarView(true)}
                className={`px-2.5 py-1 text-xs transition-colors ${
                  calendarView
                    ? 'bg-surface-2 font-medium text-text-primary'
                    : 'text-text-secondary hover:bg-surface-2/60'
                }`}
              >
                {t('console.calendar')}
              </button>
            </div>

            {calendarView ? (
              <CalendarView
                onSaveSchedule={(item, value) => p.saveMeta(item, { scheduled_at: value })}
              />
            ) : (              <>
            {/* 审核后：approved（发布操作） */}
            <PipelineStage
              title={t('console.stagePublish')}
              isEmpty={p.stageApproved.length === 0}
              emptyText={t('console.emptyPublish')}
            >
              <ul className="divide-y divide-border/60">
                {p.stageApproved.map((item) => (
                  <PublishCard
                    key={item.id}
                    item={item}
                    onPublish={(i, selfmade, target) => p.publishItem(i, selfmade, target)}
                    onSaveMeta={(i, meta) => p.saveMeta(i, meta)}
                    onRequeue={(i) => void p.act(i, 'requeue')}
                  />
                ))}
              </ul>
              <p className="border-t border-border/60 px-3 py-2 text-[10px] text-text-disabled">
                {t('console.publishHint')}
              </p>
            </PipelineStage>

            {/* 最近发布（published）：可重新发布 */}
            <div className="mt-4">
              <SectionCard title={t('console.recentPublishes')} padded={false}>
                {p.stagePublished.length === 0 ? (
                  <p className="p-3 text-sm text-text-disabled">{t('console.noPublishes')}</p>
                ) : (
                  <StageList
                    items={p.stagePublished}
                    emptyText={t('console.noPublishes')}
                    renderRow={(item) => (
                      <StageItemRow
                        item={item}
                        badge={
                          <span className="flex items-center gap-1">
                            <Badge tone="success">published</Badge>
                            {/* 分发目标（v0.3.4）：发布记录的目标徽章 */}
                            {(item.publish_json?.target ? (
                              <Badge tone="neutral">{String(item.publish_json.target)}</Badge>
                            ) : null)}
                          </span>
                        }
                        right={
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => void p.publishItem(item, false)}
                            title={t('console.republishHint')}
                          >
                            {t('console.republish')}
                          </Button>
                        }
                      />
                    )}
                  />
                )}
              </SectionCard>
            </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

