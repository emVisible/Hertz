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
  PreReviewRow,
  PublishCard,
  SectionCard,
  SortControl,
  StageItemRow,
  StageList,
  type SortField,
  type SortSpec,
} from '../../components/execution'
import { CalendarView } from './CalendarView'
import { CollectHistory } from './CollectHistory'
import { ProduceBatchModal } from '../../components/execution/ProduceBatchModal'
import { usePipelineExecution } from '../../hooks/usePipelineExecution'

// ================= Pipeline 域 =================

interface PipelineViewProps {
  limit: number
  setLimit: (v: number) => void
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
  sources: ReturnType<typeof usePipelineExecution>['sources']
  failures: Record<string, number>
  publishStatus?: ReturnType<typeof usePipelineExecution>['publishStatus']
  autoCollectMinutes: number
  collectStatus?: ReturnType<typeof usePipelineExecution>['collectStatus']
  stop: () => void
  collectProgress: ReturnType<typeof usePipelineExecution>['collectProgress']
  act: (item: PipelineItem, action: 'approve' | 'reject' | 'retry' | 'requeue' | 'retranslate') => void
  saveMeta: (item: PipelineItem, meta: Record<string, string | number | null>) => Promise<void>
  publishItem: (item: PipelineItem, selfmade?: boolean, target?: string, now?: boolean) => void
  setPublishStats: (item: PipelineItem) => void
  uploadCover: (item: PipelineItem, file: File) => void
  randomCover: (item: PipelineItem) => void
  retryClass: (cls: string, n: number) => void
  backToPrep: (item: PipelineItem) => void
  batchAction: (action: 'approve' | 'reject' | 'back_to_prep' | 'requeue', ids: string[]) => void
  rescheduleExpired: () => Promise<void>
  setProduceOptions: (items: PipelineItem[], options: Record<string, boolean>) => Promise<void>
  produceOne: (item: PipelineItem) => Promise<void>
  produceBatch: () => Promise<void>
  scoreOne: (item: PipelineItem) => Promise<void>
  scoreBatch: () => Promise<void>
  downloadOne: (item: PipelineItem) => Promise<void>
  runStep: (stepName: string, channel?: string) => Promise<void>
  /** 单条操作进行中（v0.11.4）：itemId → {action, title}——按钮转圈数据源；
   *  全局展示已移交底部「运行状态」折叠条（ActivityPanel） */
  busy: Record<string, { action: string; title: string }>
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
// v0.8.4：采集（scheduler 自动 + 手动触发，只入 DB）｜预处理（下载/评分/生产方式/制作）
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
  // 预处理阶段子菜单（v0.8.8）：未评分 / 已评分未下载 / 已下载未加工——
  // 点击切换查看对应阶段数据（原下拉折叠分组改为菜单导航；待审核归审核页签）
  const [preStage, setPreStage] = useState<'discovered' | 'scored' | 'downloaded'>('downloaded')
  const sortPreList = useMemo(() => {
    const seqOf = (item: PipelineItem) => item.seq ?? (item.created_at ? Date.parse(item.created_at) : 0)
    const updatedOf = (item: PipelineItem) =>
      item.updated_at ? Date.parse(item.updated_at) : seqOf(item)
    const sign = preSort.dir === 'asc' ? 1 : -1
    return (list: PipelineItem[]): PipelineItem[] => {
      const copy = [...list]
      switch (preSort.field) {
        case 'score':
          return copy.sort((a, b) => sign * ((b.score_total ?? -1) - (a.score_total ?? -1)))
        case 'updated':
          return copy.sort((a, b) => sign * (updatedOf(a) - updatedOf(b)))
        case 'produce': {
          // 生产方式组合排序：直发优先展示（无需加工最快），其余按模块数
          const key = (i: PipelineItem): number => {
            const o = i.produce_options ?? {}
            if ((o as { passthrough?: boolean }).passthrough) return 0
            return Object.values(o).filter(Boolean).length
          }
          return copy.sort((a, b) => key(a) - key(b) || sign * (seqOf(a) - seqOf(b)))
        }
        default:
          return copy.sort((a, b) => sign * (seqOf(a) - seqOf(b)))
      }
    }
  }, [preSort])
  // 审核排序（v0.3.12）：要素 × 方向 + 独立开关「有成片优先 / 随机洗牌」
  const [auditSort, setAuditSort] = useState<SortSpec>({ field: 'seq', dir: 'desc' })
  // 审核搜索（v0.8.9）：标题关键词过滤
  const [auditQuery, setAuditQuery] = useState('')
  const [videoFirst, setVideoFirst] = useState(true)
  const [auditRandom, setAuditRandom] = useState(false)
  // 低分复用池（v0.5 D）：仅看 is_lowscore 条目
  const [lowScoreOnly, setLowScoreOnly] = useState(false)
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
    // 低分复用池（v0.5 D）：仅看 is_lowscore 时过滤
    if (lowScoreOnly) sorted = sorted.filter((i) => i.is_lowscore)
    // 审核搜索（v0.8.9）：标题关键词（大小写不敏感）
    const q = auditQuery.trim().toLowerCase()
    if (q) sorted = sorted.filter((i) => (i.title || '').toLowerCase().includes(q))
    return sorted
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.stageQueued, auditSort, videoFirst, auditRandom, randomSeed, lowScoreOnly, auditQuery])
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
            {/* 运维控制卡（v0.8.2）：自动静默运行，监视 + 手动操作 */}
            <SectionCard title={t('console.collectOps')} padded={false}>
              <div className="flex flex-wrap items-center gap-3 p-3">
                <span className="flex items-center gap-2 text-sm">
                  <span
                    className={`inline-block h-2.5 w-2.5 rounded-full ${
                      p.collectStatus?.running ? 'animate-pulse bg-primary' : 'bg-text-disabled/40'
                    }`}
                  />
                  <span className="font-medium text-text-primary">
                    {p.collectStatus?.running
                      ? t('console.collectRunning')
                      : t('console.collectIdle')}
                  </span>
                </span>
                {/* 上次采集结果 */}
                {p.collectStatus?.last?.started_at && !p.collectStatus.running && (
                  <span className="text-xs text-text-secondary">
                    {t('console.collectLastAt', {
                      when: new Date(p.collectStatus.last.started_at).toLocaleTimeString(),
                    })}
                    {' · '}
                    {t('console.collected', {
                      n: Number((p.collectStatus.last.summary?.collected as number) ?? 0),
                    })}
                    {' · '}
                    {t('console.inserted', {
                      n: Number((p.collectStatus.last.summary?.inserted as number) ?? 0),
                    })}
                  </span>
                )}
                {/* 自动采集状态 + 下次 */}
                {p.collectStatus?.auto_enabled ? (
                  <Badge tone="success">
                    <span title={t('console.autoCollectHint')}>
                      {t('console.autoCollectOn', { n: p.collectStatus.interval_min })}
                      {p.collectStatus.next_in_s != null && !p.collectStatus.running
                        ? ` · ${t('console.collectNextIn', { s: Math.ceil(p.collectStatus.next_in_s / 60) })}`
                        : ''}
                    </span>
                  </Badge>
                ) : (
                  <Badge tone="neutral">
                    <span title={t('console.autoCollectHint')}>
                      {t('console.autoCollectOff')}
                    </span>
                  </Badge>
                )}
                <span className="flex items-center gap-1.5 text-xs">
                  <Icon name="downloads" size={13} className="text-text-disabled" />
                  <span className="text-text-secondary">
                    {t('console.preStage.discovered')}: {p.counts.discovered ?? 0}
                  </span>
                </span>
                {/* 操作：右对齐 */}
                <span className="ml-auto flex items-center gap-2">
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
                    variant="danger"
                    onClick={() => void p.stop()}
                    disabled={!p.running}
                    title={t('console.collectStopHint')}
                  >
                    <Icon name="stop" size={14} />
                    {t('console.collectStop')}
                  </Button>
                </span>
              </div>

              {/* 采集进度（v0.8.2 可视化）：最近批次各源明细 */}
              {p.collectProgress.length > 0 && (
                <div className="border-t border-border/60 p-3">
                  <div className="mb-1.5 flex items-center justify-between text-[10px] uppercase tracking-wide text-text-disabled">
                    <span>{t('console.collectProgress')}</span>
                    <span>
                      {p.collectProgress.filter((s) => s.collected != null || s.error).length}/
                      {p.collectProgress.length} {t('console.collectSources')}
                    </span>
                  </div>
                  <ul className="flex flex-col gap-1">
                    {p.collectProgress.map((s) => {
                      const done = s.collected != null || s.error != null
                      const cooling = (s.cooldown_s ?? 0) > 0
                      const failed = Boolean(s.error)
                      return (
                        <li key={s.channel} className="flex items-center gap-2 text-xs">
                          <span
                            className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
                              failed ? 'bg-error' : done ? 'bg-success' : cooling ? 'bg-warning' : 'bg-primary/60'
                            }`}
                          />
                          <span className="min-w-0 flex-1 truncate text-text-secondary">{s.channel}</span>
                          {failed ? (
                            <span className="shrink-0 text-[10px] text-error" title={s.error}>
                              {t('console.collectFailed')}
                            </span>
                          ) : done ? (
                            <span className="shrink-0 font-mono text-[10px] text-text-disabled">
                              +{s.inserted ?? 0}
                            </span>
                          ) : cooling ? (
                            <span className="shrink-0 font-mono text-[10px] text-warning">
                              ⏳ {Math.ceil(s.cooldown_s ?? 0)}s
                            </span>
                          ) : (
                            <span className="shrink-0 animate-pulse text-[10px] text-primary">
                              {t('console.collectWorking')}
                            </span>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )}
            </SectionCard>

            {/* 采集源状态（参考原项目漏斗水位）；待下载队列已并入预处理（v0.8.6） */}
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

            {/* 最近采集轮次（v0.8.7）：历史时间线——采集卡可直接回看最近 N 轮结果 */}
            <SectionCard title={t('console.act.recentCollects')} padded={false} className="shrink-0">
              <CollectHistory />
            </SectionCard>
          </div>
        )}

        {pTab === 'preReview' && (
          <div className="p-4">
            <PipelineStage
              title={`${t('console.stagePreReview')} · ${t(`console.preStage.${preStage}`)} (${p.counts[preStage] ?? 0})`}
              right={
                <div className="flex items-center gap-1.5">
                  {/* 预处理排序（v0.3.12）：要素 × 方向 */}
                  <SortControl
                    fields={PRE_SORT_FIELDS}
                    sort={preSort}
                    onSort={setPreSort}
                  />
                  <span className="flex items-center gap-1.5 border-l border-border pl-2">
                    <Select
                      aria-label={t('console.limit')}
                      value={String(p.limit)}
                      onChange={(e) => p.setLimit(Number(e.target.value))}
                      options={[5, 10, 25, 50].map((n) => ({ value: String(n), label: String(n) }))}
                      className="w-20"
                    />
                    {/* 当前阶段的批量操作（v0.8.8）：未评分→评分 / 已评分→下载 / 已下载→制作 */}
                    {preStage === 'discovered' && (
                      <Button
                        size="sm"
                        onClick={() => void p.scoreBatch()}
                        title={t('console.scoreBatchHint')}
                      >
                        <Icon name="whisper" size={12} />
                        {t('console.scoreBatch')}
                      </Button>
                    )}
                    {preStage === 'scored' && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => void p.runStep('download')}
                        disabled={p.running}
                        title={t('console.downloadHint')}
                      >
                        <Icon name="downloads" size={12} />
                        {t('console.downloadBatch')}
                      </Button>
                    )}
                    {preStage === 'downloaded' && (
                      <Button
                        size="sm"
                        onClick={() => void p.produceBatch()}
                        title={t('console.produce.batchProduceHint')}
                      >
                        <Icon name="play" size={12} />
                        {t('console.produce.batchProduce')}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setProduceBatchOpen(true)}
                      title={t('console.produce.batchHint')}
                    >
                      <Icon name="config" size={12} />
                      {t('console.produce.batch')}
                    </Button>
                  </span>
                </div>
              }
            >
              {/* 阶段子菜单（v0.8.8）：三个可导航分段——点击切换查看该阶段数据；
                  待审核已移除（归审核页签）。分段控件风格：激活段填充高亮 */}
              <div
                role="tablist"
                aria-label={t('console.stagePreReview')}
                className="flex gap-1 border-b border-border bg-surface-2/40 px-3 py-2"
              >
                {(
                  [
                    { key: 'discovered', n: p.counts.discovered ?? 0 },
                    { key: 'scored', n: p.counts.scored ?? 0 },
                    { key: 'downloaded', n: p.counts.downloaded ?? 0 },
                  ] as const
                ).map((seg) => {
                  const active = preStage === seg.key
                  return (
                    <button
                      key={seg.key}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => setPreStage(seg.key)}
                      className={`flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs transition-colors ${
                        active
                          ? 'bg-surface-1 font-medium text-text-primary shadow-sm ring-1 ring-border'
                          : 'text-text-secondary hover:bg-surface-1/50 hover:text-text-primary'
                      }`}
                    >
                      <span className="truncate">{t(`console.preStage.${seg.key}`)}</span>
                      <span className={`shrink-0 font-mono text-[10px] ${active ? 'text-text-secondary' : 'text-text-disabled'}`}>
                        {seg.n}
                      </span>
                    </button>
                  )
                })}
              </div>

              {/* 当前阶段数据列表（单阶段渲染——菜单即导航） */}
              <StageList
                items={
                  preStage === 'discovered'
                    ? sortPreList(p.stageDiscovered)
                    : preStage === 'scored'
                      ? sortPreList(p.stageScored)
                      : sortPreList(p.stageDownloaded)
                }
                emptyText={t(`console.preEmpty.${preStage}`)}
                total={p.counts[preStage] ?? 0}
                renderRow={(item) =>
                  preStage === 'downloaded' ? (
                    // 已下载未加工：卡式（生产方式选择需要空间）
                    <PreReviewCard
                      key={item.id}
                      item={item}
                      onSaveOptions={(i, options) => void p.setProduceOptions([i], options)}
                      onProduce={(i) => void p.produceOne(i)}
                      onReject={(i) => void p.act(i, 'reject')}
                      onUploadCover={(i, file) => void p.uploadCover(i, file)}
                    />
                  ) : (
                    // 未评分/已评分：紧凑行（v0.8.9 三阶段差异化——列表式浏览）
                    <PreReviewRow
                      key={item.id}
                      item={item}
                      stage={preStage}
                      onScore={(i) => void p.scoreOne(i)}
                      onDownload={(i) => void p.downloadOne(i)}
                      onReject={(i) => void p.act(i, 'reject')}
                    />
                  )
                }
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
                  {/* 审核搜索（v0.8.9）：标题关键词过滤——本地过滤当前队列 */}
                  <input
                    type="search"
                    value={auditQuery}
                    onChange={(e) => setAuditQuery(e.target.value)}
                    placeholder={t('console.auditSearch')}
                    className="h-6 w-36 rounded-sm border border-border bg-surface-1 px-2 text-[11px] text-text-primary outline-none placeholder:text-text-disabled focus:border-primary"
                  />
                  {/* 审核排序（v0.3.12）：要素 × 方向 + 独立开关 */}
                  <SortControl fields={AUDIT_SORT_FIELDS} sort={auditSort} onSort={setAuditSort} />
                  {/* 仅看低分（v0.5 D 低分复用池）：is_lowscore 过滤 */}
                  <button
                    type="button"
                    onClick={() => setLowScoreOnly((v) => !v)}
                    title={t('console.lowScoreOnlyHint')}
                    className={`shrink-0 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                      lowScoreOnly
                        ? 'border-warning/50 bg-warning/15 font-medium text-warning'
                        : 'border-transparent text-text-disabled hover:border-border hover:text-text-secondary'
                    }`}
                  >
                    {t('console.lowScoreOnly')}
                  </button>
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
            {/* 低分回收池（v0.5 D）：is_lowscore 条目批量恢复待审（可复用） */}
            {(() => {
              const low = [...p.stageQueued, ...p.stageRejected, ...p.stageFailed].filter((i) => i.is_lowscore)
              if (low.length === 0) return null
              return (
                <SectionCard
                  title={`${t('console.lowScorePool')} (${low.length})`}
                  padded={false}
                  className="mb-4"
                >
                  <div className="flex flex-wrap items-center gap-1.5 border-b border-border/60 px-3 py-2">
                    <p className="text-xs text-text-secondary">{t('console.lowScorePoolHint')}</p>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="ml-auto"
                      onClick={() => void p.batchAction('requeue', low.map((i) => i.id))}
                    >
                      <Icon name="refresh" size={12} />
                      {t('console.lowScoreRestoreAll', { n: low.length })}
                    </Button>
                  </div>
                  <StageList
                    items={low}
                    emptyText={t('console.noExceptions')}
                    renderRow={(item) => (
                      <StageItemRow
                        item={item}
                        badge={<Badge tone="warning">low</Badge>}
                        right={
                          <Button
                            size="sm"
                            variant="ghost"
                                loading={p.busy[item.id]?.action === 'requeue'}
                            disabled={!!p.busy[item.id]}
                            onClick={() => void p.act(item, 'requeue')}
                          >
                            {t('console.restore')}
                          </Button>
                        }
                      />
                    )}
                  />
                </SectionCard>
              )
            })()}
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
                          <>
                            <Button
                              size="sm"
                              variant="ghost"
                              loading={p.busy[item.id]?.action === 'retranslate'}
                              disabled={!!p.busy[item.id]}
                              onClick={() => void p.act(item, 'retranslate')}
                              title={t('console.retranslateHint')}
                            >
                              {t('console.retranslate')}
                            </Button>
                            {item.status === 'failed' ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                loading={p.busy[item.id]?.action === 'retry'}
                                disabled={!!p.busy[item.id]}
                                onClick={() => void p.act(item, 'retry')}
                              >
                                {t('common.retry')}
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                variant="ghost"
                            loading={p.busy[item.id]?.action === 'requeue'}
                                disabled={!!p.busy[item.id]}
                                onClick={() => void p.act(item, 'requeue')}
                              >
                                {t('console.restore')}
                              </Button>
                            )}
                          </>
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
                    onPublish={(i, selfmade, target, now) => p.publishItem(i, selfmade, target, now)}
                    onSaveMeta={(i, meta) => p.saveMeta(i, meta)}
                    onRequeue={(i) => void p.act(i, 'requeue')}
                    onRandomCover={(i) => void p.randomCover(i)}
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

