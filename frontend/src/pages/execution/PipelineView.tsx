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
  SortControl,
  StageItemRow,
  StageList,
  type SortField,
  type SortSpec,
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
  publishStatus?: ReturnType<typeof usePipelineExecution>['publishStatus']
  logs: ReturnType<typeof usePipelineExecution>['logs']
  run: () => void
  stop: () => void
  act: (item: PipelineItem, action: 'approve' | 'reject' | 'retry' | 'requeue') => void
  saveMeta: (item: PipelineItem, meta: Record<string, string | number | null>) => Promise<void>
  publishItem: (item: PipelineItem, selfmade?: boolean, target?: string) => void
  setPublishStats: (item: PipelineItem) => void
  uploadCover: (item: PipelineItem, file: File) => void
  retryClass: (cls: string, n: number) => void
  backToPrep: (item: PipelineItem) => void
  backToCollect: (item: PipelineItem) => void
  batchAction: (action: 'approve' | 'reject' | 'back_to_prep', ids: string[]) => void
  rescheduleExpired: () => Promise<void>
  setProduceOptions: (items: PipelineItem[], options: Record<string, boolean>) => Promise<void>
  produceOne: (item: PipelineItem) => Promise<void>
  produceBatch: () => Promise<void>
  collectAndDownload: () => Promise<void>
  scoreOne: (item: PipelineItem) => Promise<void>
  scoreBatch: () => Promise<void>
  runStep: (stepName: string, channel?: string) => Promise<void>
  modelSwitch: ReturnType<typeof useModelSwitch>
}

type PipelineTabId = 'run' | 'preReview' | 'inReview' | 'postReview' | 'exceptions'

// 排序要素（v0.3.12 两维度：要素 × 方向）
const PRE_SORT_FIELDS: SortField[] = [
  { id: 'seq', labelKey: 'console.sort.seq' },
  { id: 'score', labelKey: 'console.sort.score' },
  { id: 'produce', labelKey: 'console.sort.produce' },
  { id: 'updated', labelKey: 'console.sort.updated' },
]
const AUDIT_SORT_FIELDS: SortField[] = [
  { id: 'seq', labelKey: 'console.sort.seq' },
  { id: 'score', labelKey: 'console.sort.score' },
  { id: 'reddit', labelKey: 'console.sort.reddit' },
  { id: 'title', labelKey: 'console.sort.title' },
  { id: 'updated', labelKey: 'console.sort.updated' },
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

export function PipelineView(p: PipelineViewProps) {
  const { t } = useTranslation()
  // 发布 tab 视图：列表（默认）｜内容日历（v0.2.3）
  const [calendarView, setCalendarView] = useState(false)
  // 批量生产方式（v0.3.3，预处理）
  const [produceBatchOpen, setProduceBatchOpen] = useState(false)
  // 预处理排序（v0.3.12）：要素 × 方向两维度；默认 入库序+降序（最新在前）
  const [preSort, setPreSort] = useState<SortSpec>({ field: 'seq', dir: 'desc' })
  const sortedPreReview = useMemo(() => {
    const list = [...p.stageDownloaded, ...p.stageScored]
    const seqOf = (item: PipelineItem) => item.seq ?? (item.created_at ? Date.parse(item.created_at) : 0)
    const updatedOf = (item: PipelineItem) =>
      item.updated_at ? Date.parse(item.updated_at) : seqOf(item)
    const sign = preSort.dir === 'asc' ? 1 : -1
    switch (preSort.field) {
      case 'score':
        return list.sort((a, b) => sign * ((b.score_total ?? -1) - (a.score_total ?? -1)))
      case 'updated':
        return list.sort((a, b) => sign * (updatedOf(a) - updatedOf(b)))
      case 'produce': {
        // 生产方式组合排序：直发优先展示（无需加工最快），其余按模块数
        const key = (i: PipelineItem): number => {
          const o = i.produce_options ?? {}
          if ((o as { passthrough?: boolean }).passthrough) return 0
          return Object.values(o).filter(Boolean).length
        }
        return list.sort((a, b) => key(a) - key(b) || sign * (seqOf(a) - seqOf(b)))
      }
      default:
        return list.sort((a, b) => sign * (seqOf(a) - seqOf(b)))
    }
  }, [p.stageDownloaded, p.stageScored, preSort])
  // 审核排序（v0.3.12）：要素 × 方向 + 独立开关「有成片优先 / 随机洗牌」
  const [auditSort, setAuditSort] = useState<SortSpec>({ field: 'seq', dir: 'desc' })
  const [videoFirst, setVideoFirst] = useState(true)
  const [auditRandom, setAuditRandom] = useState(false)
  const [randomSeed, setRandomSeed] = useState(0)
  function toggleAuditRandom() {
    const next = !auditRandom
    setAuditRandom(next)
    if (next) setRandomSeed(Date.now())  // 每次开启重新洗牌
  }
  const sortedQueued = useMemo(() => {
    const list = [...p.stageQueued]
    // 入库顺序（v0.3.1）：seq 自增序号优先（同批 created_at 相同无法区分先后），
    // 旧数据无 seq 时回退 created_at 时间戳
    const seqOf = (item: PipelineItem) => item.seq ?? (item.created_at ? Date.parse(item.created_at) : 0)
    const updatedOf = (item: PipelineItem) =>
      item.updated_at ? Date.parse(item.updated_at) : seqOf(item)
    const sign = auditSort.dir === 'asc' ? 1 : -1
    if (auditRandom) {
      // 每次开启随机生成一次洗牌（seed 变化触发重排），而非每帧重排
      const shuffled = [...list]
      for (let i = shuffled.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
      }
      return shuffled
    }
    let sorted: PipelineItem[]
    switch (auditSort.field) {
      case 'score':
        sorted = list.sort((a, b) => sign * ((b.score_total ?? -1) - (a.score_total ?? -1)))
        break
      case 'reddit':
        sorted = list.sort((a, b) => sign * (a.reddit_score - b.reddit_score))
        break
      case 'title':
        sorted = list.sort((a, b) => sign * a.title.localeCompare(b.title, 'zh'))
        break
      case 'updated':
        sorted = list.sort((a, b) => sign * (updatedOf(a) - updatedOf(b)))
        break
      default:
        sorted = list.sort((a, b) => sign * (seqOf(a) - seqOf(b)))
    }
    if (videoFirst) {
      // 有成片优先：可预览的排前面，同组内保持当前排序
      const withVideo = sorted.filter((i) => i.video_path)
      const rest = sorted.filter((i) => !i.video_path)
      sorted = [...withVideo, ...rest]
    }
    return sorted
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.stageQueued, auditSort, videoFirst, auditRandom, randomSeed])
  const pTab: PipelineTabId = PIPELINE_TABS.some((tb) => tb.id === p.tab)
    ? (p.tab as PipelineTabId)
    : 'inReview'

  // ---- 审核效率（v0.4 A1 快捷键 / A2 批量） ----
  const [auditFocus, setAuditFocus] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const toggleSelect = (item: PipelineItem) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(item.id)) next.delete(item.id)
      else next.add(item.id)
      return next
    })
  }
  const clearSelection = () => setSelectedIds(new Set())

  // j/k 导航 + a/r/b 操作（仅 inReview tab；输入框/⌘ 组合键不拦截）
  useEffect(() => {
    if (pTab !== 'inReview') {
      setAuditFocus(null)
      return
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const tgt = e.target
      if (
        tgt instanceof HTMLInputElement ||
        tgt instanceof HTMLTextAreaElement ||
        tgt instanceof HTMLSelectElement
      ) {
        return
      }
      const list = sortedQueued
      if (list.length === 0) return
      let idx = auditFocus ? list.findIndex((i) => i.id === auditFocus) : -1
      const move = (next: number) => {
        e.preventDefault()
        setAuditFocus(list[Math.max(0, Math.min(next, list.length - 1))].id)
      }
      switch (e.key) {
        case 'j':
        case 'J':
        case 'ArrowDown':
          move(idx + 1)
          break
        case 'k':
        case 'K':
        case 'ArrowUp':
          move(idx < 0 ? 0 : idx - 1)
          break
        case 'a':
        case 'A':
          if (idx >= 0) {
            e.preventDefault()
            void p.act(list[idx], 'approve')
            setAuditFocus(null)
          }
          break
        case 'r':
        case 'R':
          if (idx >= 0) {
            e.preventDefault()
            void p.act(list[idx], 'reject')
            setAuditFocus(null)
          }
          break
        case 'b':
        case 'B':
          if (idx >= 0) {
            e.preventDefault()
            void p.backToPrep(list[idx])
            setAuditFocus(null)
          }
          break
        case 'Escape':
          setAuditFocus(null)
          setSelectedIds(new Set())
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pTab, sortedQueued, auditFocus])

  // 焦点项滚动到可视区（列表长时 j/k 不迷路）
  useEffect(() => {
    if (!auditFocus) return
    document
      .getElementById(`audit-item-${auditFocus}`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [auditFocus])

  // 批量操作（v0.4 A2）
  const selectedItems = sortedQueued.filter((i) => selectedIds.has(i.id))
  function batchRun(action: 'approve' | 'reject' | 'back_to_prep') {
    void p.batchAction(action, [...selectedIds])
    clearSelection()
  }

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

            {/* 待下载队列（v0.3.5）：discovered 条目——下载前的供给可见。
                v0.3.12：无限滚动分页（此前 max-h 截断 349 条只能看到 ~8 行） */}
            <SectionCard
              title={`${t('console.pendingDownloads')} (${p.counts.discovered ?? 0})`}
              padded={false}
              className="shrink-0"
            >
              <StageList
                items={p.stageDiscovered}
                emptyText={t('console.noPendingDownloads')}
                total={p.counts.discovered ?? 0}
                pageSize={50}
                renderRow={(item) => (
                  <li key={item.id} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                    <span className="min-w-0 flex-1 truncate text-text-secondary" title={item.title}>
                      {item.title}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-text-disabled">
                      r{item.reddit_score}
                    </span>
                  </li>
                )}
              />
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
                    {/* 单源采集（v0.5 C）：源失联/冷却后可单独重试 */}
                    <button
                      type="button"
                      disabled={p.running}
                      onClick={() => void p.runStep('collect', s.channel)}
                      title={t('console.collectSourceHint')}
                      className="shrink-0 border border-border px-1.5 py-0.5 text-[10px] text-text-secondary transition-colors hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Icon name="downloads" size={11} />
                    </button>
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
                  {/* 预处理排序（v0.3.12）：要素 × 方向 */}
                  <SortControl
                    fields={PRE_SORT_FIELDS}
                    sort={preSort}
                    onSort={setPreSort}
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
              {/* v0.4 E4 空态引导：数据在待下载队列时指路，不让人困惑 */}
              {sortedPreReview.length === 0 && (p.counts.discovered ?? 0) > 0 && (
                <div className="flex items-center gap-2 border-b border-border bg-surface-2/40 px-3 py-2 text-xs text-text-secondary">
                  <Icon name="downloads" size={12} className="shrink-0 text-text-disabled" />
                  <span className="min-w-0">
                    {t('console.preReviewEmptyHint', { n: p.counts.discovered ?? 0 })}
                  </span>
                  <button
                    type="button"
                    onClick={() => p.setTab('run')}
                    className="ml-auto shrink-0 text-primary underline-offset-2 hover:underline"
                  >
                    {t('console.preReviewGoCollect')}
                  </button>
                </div>
              )}
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
                      onBackToCollect={(i) => void p.backToCollect(i)}
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
                <span className="flex items-center gap-1.5">
                  {/* 审核排序（v0.3.12）：要素 × 方向 + 独立开关 */}
                  <SortControl fields={AUDIT_SORT_FIELDS} sort={auditSort} onSort={setAuditSort} />
                  <button
                    type="button"
                    onClick={() => setVideoFirst((v) => !v)}
                    title={t('console.sort.videoFirstHint')}
                    className={`shrink-0 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                      videoFirst
                        ? 'border-primary/40 bg-primary/15 font-medium text-primary'
                        : 'border-transparent text-text-disabled hover:border-border hover:text-text-secondary'
                    }`}
                  >
                    {t('console.sort.videoFirst')}
                  </button>
                  <button
                    type="button"
                    onClick={toggleAuditRandom}
                    title={t('console.sort.randomHint')}
                    className={`shrink-0 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                      auditRandom
                        ? 'border-warning/50 bg-warning/15 font-medium text-warning'
                        : 'border-transparent text-text-disabled hover:border-border hover:text-text-secondary'
                    }`}
                  >
                    🎲 {t('console.sort.random')}
                  </button>
                </span>
              }
            >
              {/* 批量操作条（v0.4 A2）：选中 ≥1 时浮现 */}
              {selectedItems.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface-2/60 px-3 py-2 text-xs">
                  <span className="font-medium text-text-primary">
                    {t('console.batchSelected', { n: selectedItems.length })}
                  </span>
                  <span className="text-text-disabled">{t('console.batchHint')}</span>
                  <span className="ml-auto flex items-center gap-1.5">
                    <Button size="sm" onClick={() => batchRun('approve')}>
                      <Icon name="check" size={12} />
                      {t('console.batchApprove')}
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => batchRun('back_to_prep')}>
                      <Icon name="rewind" size={12} />
                      {t('console.batchBackToPrep')}
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => batchRun('reject')}>
                      <Icon name="close" size={12} />
                      {t('console.batchReject')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={clearSelection}>
                      {t('console.batchClear')}
                    </Button>
                  </span>
                </div>
              )}
              <ul className="divide-y divide-border/60">
                {sortedQueued.map((item) => (
                    <AuditCard
                      key={item.id}
                      item={item}
                      onApprove={(i) => void p.act(i, 'approve')}
                      onReject={(i) => void p.act(i, 'reject')}
                      onUploadCover={(i, file) => void p.uploadCover(i, file)}
                      onBackToPrep={(i) => void p.backToPrep(i)}
                      focused={auditFocus === item.id}
                      selected={selectedIds.has(item.id)}
                      onSelect={toggleSelect}
                    />
                ))}
              </ul>
              <p className="border-t border-border/60 px-3 py-2 text-[10px] text-text-disabled">
                {t('console.keyHint')}
              </p>
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
            {/* 发布目标状态（v0.3.8）：noop/缺 cookie 时醒目警示，避免「点了没反应」 */}
            {p.publishStatus && (
              <div
                className={`mx-4 mt-3 flex items-start gap-2 rounded border px-3 py-2 text-xs ${
                  p.publishStatus.noop
                    ? 'border-warning/40 bg-warning/10 text-warning'
                    : p.publishStatus.target === 'bilibili' && !p.publishStatus.cookie_exists
                      ? 'border-warning/40 bg-warning/10 text-warning'
                      : 'border-border bg-surface-1/60 text-text-secondary'
                }`}
              >
                <Icon name="config" size={13} className="mt-0.5 shrink-0" />
                <div className="min-w-0">
                  {p.publishStatus.noop ? (
                    <>
                      <span className="font-medium">{t('console.publishNoopTitle')}</span>
                      <span className="ml-2">{t('console.publishNoopHint')}</span>
                    </>
                  ) : p.publishStatus.target === 'bilibili' && !p.publishStatus.cookie_exists ? (
                    <>
                      <span className="font-medium">
                        {t('console.publishCookieMissing')} — {p.publishStatus.cookie_path}
                      </span>
                      <span className="ml-2">{t('console.publishCookieHint')}</span>
                    </>
                  ) : (
                    <>
                      <span className="font-medium">
                        {t('console.publishReady')} → {p.publishStatus.target}
                      </span>
                      {p.publishStatus.target === 'bilibili' && (
                        <span className="ml-2">{t('console.publishCookieReady')}</span>
                      )}
                    </>
                  )}
                </div>
              </div>
            )}
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

            {/* 发布历史（v0.3.8）：已发布内容完整回到发布列表（100 条） */}
            <div className="mt-4">
              <SectionCard title={`${t('console.publishHistory')} (${p.stagePublished.length})`} padded={false}>
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
                            {/* 发布数据（v0.4 C1）：回捞/补录的播放·互动 */}
                            {(() => {
                              const stats = (item.publish_json?.stats ?? null) as
                                | Record<string, number>
                                | null
                              if (!stats) return null
                              return (
                                <Badge tone="primary">
                                  <span title={t('console.statsTitle')}>
                                    ▶ {stats.view ?? 0}
                                  </span>
                                </Badge>
                              )
                            })()}
                            {/* 发布时间（v0.3.8） */}
                            {item.published_at && (
                              <span className="font-mono text-[10px] text-text-disabled">
                                {new Date(item.published_at).toLocaleString()}
                              </span>
                            )}
                          </span>
                        }
                        right={
                          <span className="flex items-center gap-1.5">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => void p.setPublishStats(item)}
                              title={t('console.statsHint')}
                            >
                              <Icon name="tag" size={12} />
                              {t('console.stats')}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => void p.act(item, 'requeue')}
                              title={t('console.backToReviewHint')}
                            >
                              {t('console.backToReview')}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => void p.publishItem(item, false)}
                              title={t('console.republishHint')}
                            >
                              {t('console.republish')}
                            </Button>
                          </span>
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

