import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { api } from '../api'
import { pipelineApi, type CollectSourceRun, type LogLineHistory, type PipelineJob } from '../api/pipeline'
import { Icon } from './ui'
import { useExecutionStore } from '../stores/execution'
import type { LogLine } from './execution'

type ActivityTab = 'events' | 'jobs' | 'system'

const JOB_PAGE = 50
const LOG_PAGE = 120
const JOB_KINDS = ['collect', 'score', 'download', 'produce', 'chain', 'publish'] as const

/** 相对时间（v0.8.7）：几秒前 / N 分钟前 / HH:MM。 */
function formatAgo(ts: string | null, justNow: string): string {
  if (!ts) return '—'
  const t = Date.parse(ts)
  if (Number.isNaN(t)) return ts.slice(11, 19)
  const diff = Date.now() - t
  const min = Math.floor(diff / 60_000)
  if (min < 1) return justNow
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h`
  return ts.slice(5, 16).replace('T', ' ')
}

function JobStatusDot({ status }: { status: string }) {
  const tone =
    status === 'completed'
      ? 'bg-emerald-400'
      : status === 'failed'
        ? 'bg-red-400'
        : 'bg-amber-400 animate-pulse'
  return <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone}`} />
}

/** 列表行摘要（v0.8.8 轻量字段：sources_ok/err 计数，无逐源明细）。 */
function JobSummaryText({ job, t }: { job: PipelineJob; t: (k: string, o?: Record<string, unknown>) => string }) {
  const s = job.summary
  if (job.job === 'collect') {
    const ok = s.sources_ok ?? 0
    const err = s.sources_err ?? 0
    return err > 0 ? (
      <span className="truncate text-amber-400/90">
        {t('console.act.collectRoundErr', { n: s.collected ?? 0, ins: s.inserted ?? 0, ok, err })}
      </span>
    ) : (
      <span className="truncate text-text-secondary">
        {t('console.act.collectRoundOk', { n: s.collected ?? 0, ins: s.inserted ?? 0, ok })}
      </span>
    )
  }
  const parts: string[] = []
  if (s.processed != null) parts.push(`${t('console.act.processed', { n: s.processed })}`)
  if (s.ok != null) parts.push(`${t('console.act.ok', { n: s.ok })}`)
  if (s.failed != null && s.failed > 0) parts.push(`${t('console.act.failed', { n: s.failed })}`)
  return <span className="truncate text-text-secondary">{parts.join(' · ') || job.error || '—'}</span>
}

/** collect 任务逐源明细表（v0.8.7）：channel × collected/inserted/skipped/error。 */
function CollectDetail({ summary }: { summary: Record<string, unknown> }) {
  const { t } = useTranslation()
  const runs = (summary.sources as CollectSourceRun[] | undefined) ?? []
  return (
    <div className="flex flex-col gap-0.5 font-mono text-[10px]">
      {runs.length === 0 && <p className="text-text-disabled">—</p>}
      {runs.map((r) => {
        const bad = r.error != null || r.empty
        return (
          <div key={r.channel} className="flex items-center gap-2 rounded-sm px-1.5 py-0.5 odd:bg-surface-2/40">
            <span className="min-w-0 flex-1 truncate text-text-primary">{r.channel}</span>
            <span className="shrink-0 tabular-nums text-text-secondary">{t('console.act.colDetail', { n: r.collected ?? 0 })}</span>
            <span className="shrink-0 tabular-nums text-emerald-400/90">{t('console.act.insDetail', { n: r.inserted ?? 0 })}</span>
            <span className="shrink-0 tabular-nums text-text-disabled">{t('console.act.skipDetail', { n: r.skipped ?? 0 })}</span>
            {r.cooldown_s ? (
              <span className="shrink-0 tabular-nums text-amber-400/90">{t('console.act.cdDetail', { n: r.cooldown_s })}</span>
            ) : null}
            {r.error ? (
              <span className="max-w-[240px] shrink-0 truncate text-red-400/90" title={r.error}>
                {r.error}
              </span>
            ) : bad ? (
              <span className="shrink-0 text-amber-400/90">{t('console.act.emptyDetail')}</span>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

/** 任务详情展开（v0.8.7 企业级对齐：GH Actions 行内展开语义）。
 *  v0.8.8 查漏补缺：改为懒加载——列表只传轻量摘要，展开时经 /jobs/{id}
 *  拉完整 summary（逐源明细/delta），避免 50 条列表轮询全量传输（§2.3/§7.2）。 */
function JobDetail({ jobId }: { jobId: string }) {
  const { t } = useTranslation()
  const { data: job } = useQuery({
    queryKey: ['pipeline-job-detail', jobId],
    queryFn: () => pipelineApi.jobDetail(jobId),
    enabled: !!jobId,
    refetchInterval: 15_000,
  })

  if (!job) {
    return (
      <div className="hz-fade-in flex items-center gap-1.5 border-t border-border/60 bg-surface-2/20 px-3 py-2 text-[10px] text-text-disabled">
        <Icon name="refresh" size={10} className="animate-spin" />
        …
      </div>
    )
  }
  return (
    <div className="hz-fade-in flex flex-col gap-2 border-t border-border/60 bg-surface-2/20 px-3 py-2">
      {/* 信息格栅：开始 / 结束 / 耗时 */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px] sm:grid-cols-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-text-disabled">{t('console.act.startedAt')}</span>
          <span className="font-mono text-text-secondary">{job.started_at?.slice(0, 19).replace('T', ' ') ?? '—'}</span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-text-disabled">{t('console.act.finishedAt')}</span>
          <span className="font-mono text-text-secondary">{job.finished_at?.slice(0, 19).replace('T', ' ') ?? '—'}</span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-text-disabled">{t('console.act.duration')}</span>
          <span className="font-mono text-text-secondary">{job.duration_s != null ? `${job.duration_s}s` : '—'}</span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-text-disabled">{t('console.act.jobStatus')}</span>
          <span className={`font-mono ${job.status === 'failed' ? 'text-red-400' : job.status === 'completed' ? 'text-emerald-400' : 'text-amber-400'}`}>
            {job.status}
          </span>
        </div>
      </div>
      {/* collect：逐源明细 */}
      {job.job === 'collect' && (
        <div className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wide text-text-disabled">{t('console.act.sourceRun')}</span>
          <CollectDetail summary={job.summary} />
        </div>
      )}
      {/* delta（若存在）：状态增减 */}
      {job.summary.delta != null && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[10px] uppercase tracking-wide text-text-disabled">{t('console.act.delta')}</span>
          {Object.entries(job.summary.delta as Record<string, number>).map(([k, v]) => (
            <span
              key={k}
              className={`border px-1.5 py-0.5 font-mono text-[10px] leading-none ${
                v > 0 ? 'border-emerald-400/30 text-emerald-400' : v < 0 ? 'border-amber-400/30 text-amber-400' : 'border-border/60 text-text-disabled'
              }`}
            >
              {k} {v > 0 ? '+' : ''}{v}
            </span>
          ))}
        </div>
      )}
      {/* 错误详情 */}
      {job.error && (
        <p className="break-all rounded-sm border border-red-400/25 bg-red-400/5 px-2 py-1 font-mono text-[10px] text-red-400/90">
          {job.error}
        </p>
      )}
    </div>
  )
}

/**
 * 全局活动横条（v0.3.5，浏览器下载栏语义）：AppShell 底部常驻。
 * v0.8.7 企业级对齐（Airflow run 详情 / Jenkins 构建 / GH Actions 展开 / Loki 日志）：
 * - 最近任务：DB 历史分页 + 类型/状态筛选 + 行内展开详情（collect 逐源明细/delta/错误）
 * - 系统日志：持久化文件历史（级别筛选/关键字/时间游标加载更多），不再仅限内存 buffer
 * - 实时事件：SSE 实时流（同源已落盘，完整历史见系统日志）
 */
export function ActivityPanel() {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<ActivityTab>('events')
  const logs = useExecutionStore((s) => s.pipeline.logs)
  const panelRef = useRef<HTMLDivElement>(null)
  const justNow = t('console.act.justNow')

  // ---------- 最近任务（v0.8.7：分页 + 筛选 + 展开） ----------
  const [jobFilter, setJobFilter] = useState('')
  const [jobStatus, setJobStatus] = useState('')
  const [jobOffset, setJobOffset] = useState(0)
  const [expanded, setExpanded] = useState<string | null>(null)
  const { data: jobsPage } = useQuery({
    queryKey: ['pipeline-jobs-page', jobFilter, jobStatus, jobOffset],
    queryFn: () => pipelineApi.jobsPage(JOB_PAGE, jobOffset, jobFilter, jobStatus),
    refetchInterval: open && tab === 'jobs' ? 8000 : false,
  })
  // v0.8.8 查漏补缺（§35 前端状态与渲染时序）：累计列表由本地 state 管理——
  // 第一页/筛选变化替换，加载更多与轮询按 id 去重追加（此前直接取当前页，翻页即错乱）
  const [jobs, setJobs] = useState<PipelineJob[]>([])
  useEffect(() => {
    if (!jobsPage) return
    if (jobOffset === 0) {
      setJobs(jobsPage.jobs)
    } else {
      setJobs((prev) => {
        const seen = new Set(prev.map((j) => j.id))
        return [...prev, ...jobsPage.jobs.filter((j) => !seen.has(j.id))]
      })
    }
  }, [jobsPage]) // eslint-disable-line react-hooks/exhaustive-deps
  const hasMoreJobs = jobsPage != null && jobsPage.total > jobs.length

  // ---------- 系统日志（v0.8.7：文件历史 + 级别/关键字/游标） ----------
  const [logLevel, setLogLevel] = useState('')
  const [logQ, setLogQ] = useState('')
  const [lines, setLines] = useState<LogLineHistory[]>([])
  const [logHasMore, setLogHasMore] = useState(false)
  const [logLoadingMore, setLogLoadingMore] = useState(false)
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 轮询只查询初始页（无 until）；加载更多走一次性请求（v0.8.8：
  // 此前 until 进 queryKey，轮询触发 useEffect 重复追加历史行——§35 渲染时序）
  const { data: logPage } = useQuery({
    queryKey: ['sys-logs-page', logLevel, logQ],
    queryFn: () =>
      api.get<{ lines: LogLineHistory[]; has_more: boolean; fallback?: boolean }>(
        `/api/logs?limit=${LOG_PAGE}${logLevel ? `&level=${logLevel}` : ''}${logQ ? `&q=${encodeURIComponent(logQ)}` : ''}`,
      ),
    refetchInterval: open && tab === 'system' ? 8000 : false,
  })
  useEffect(() => {
    if (!logPage) return
    setLines(logPage.lines)
    setLogHasMore(logPage.has_more ?? false)
  }, [logPage])

  async function loadMoreLogs() {
    const lastTs = lines[lines.length - 1]?.ts
    if (!lastTs || logLoadingMore) return
    setLogLoadingMore(true)
    try {
      const page = await api.get<{ lines: LogLineHistory[]; has_more: boolean }>(
        `/api/logs?limit=${LOG_PAGE}&until=${encodeURIComponent(lastTs)}${logLevel ? `&level=${logLevel}` : ''}${logQ ? `&q=${encodeURIComponent(logQ)}` : ''}`,
      )
      setLines((prev) => {
        const seen = new Set(prev.map((l) => `${l.ts}|${l.message}`))
        return [...prev, ...page.lines.filter((l) => !seen.has(`${l.ts}|${l.message}`))]
      })
      setLogHasMore(page.has_more ?? false)
    } finally {
      setLogLoadingMore(false)
    }
  }

  function changeLogQ(v: string) {
    if (searchTimer.current) clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => {
      setLogQ(v.trim()) // 新搜索从最新开始（queryKey 变化自动替换列表）
    }, 300)
  }
  function changeLogLevel(v: string) {
    setLogLevel(v)
  }
  function changeJobFilter(v: string) {
    setJobOffset(0)
    setExpanded(null)
    setJobFilter(v)
  }
  function changeJobStatus(v: string) {
    setJobOffset(0)
    setExpanded(null)
    setJobStatus(v)
  }

  // Esc / 外部点击收起
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onDown = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown)
    }
  }, [open])

  const tabs: Array<{ id: ActivityTab; label: string }> = [
    { id: 'events', label: t('console.act.events') },
    { id: 'jobs', label: t('console.jobs') },
    { id: 'system', label: t('console.sysLogs') },
  ]

  const chip = (active: boolean) =>
    `shrink-0 rounded-full border px-2 py-0.5 text-[10px] leading-none transition-colors ${
      active
        ? 'border-primary/50 bg-primary/15 font-medium text-primary'
        : 'border-transparent text-text-disabled hover:border-border hover:text-text-secondary'
    }`

  return (
    <div ref={panelRef} className="fixed bottom-0 left-0 right-0 z-40">
      {/* 收起态窄条（浏览器下载栏收起语义）：点击展开 */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={t('console.act.title')}
        aria-label={t('console.act.title')}
        className={`flex h-7 w-full items-center gap-2 border-t border-border bg-surface-1/95 px-4 text-[11px] text-text-secondary backdrop-blur transition-colors hover:text-text-primary ${
          open ? 'border-b' : ''
        }`}
      >
        <Icon name="console" size={12} className={logs.length > 0 ? 'animate-pulse text-primary' : 'text-text-disabled'} />
        <span className="truncate">
          {t('console.act.title')}
          {logs.length > 0 && !open && <span className="ml-2 text-text-disabled">· {t('console.act.eventsCount', { n: logs.length })}</span>}
        </span>
        <span className="ml-auto shrink-0">{t('console.act.toggle')}</span>
      </button>

      {open && (
        <div className="hz-fade-in border-t border-border bg-surface-1/95 shadow-lg backdrop-blur">
          {/* tab 栏 */}
          <div className="flex items-center gap-1 px-2 pt-1.5">
            {tabs.map((tb) => (
              <button
                key={tb.id}
                type="button"
                onClick={() => setTab(tb.id)}
                className={`flex-1 border-b-2 px-2 py-1 text-xs font-medium transition-colors ${
                  tab === tb.id
                    ? 'border-primary text-text-primary'
                    : 'border-transparent text-text-secondary hover:text-text-primary'
                }`}
              >
                {tb.label}
              </button>
            ))}
          </div>

          {/* 内容区（固定高度，内部滚动） */}
          <div className="h-56 overflow-y-auto p-2">
            {/* ---------- 实时事件 ---------- */}
            {tab === 'events' && (
              <div className="flex flex-col gap-1 font-mono text-[10px] leading-relaxed">
                {logs.length === 0 && <p className="p-2 text-text-disabled">{t('console.noLogs')}</p>}
                {logs.map((log: LogLine) => (
                  <div key={log.id} className="flex gap-1.5 px-1">
                    <span className="shrink-0 select-none text-text-disabled">{log.time}</span>
                    <span className="min-w-0 break-all text-text-secondary">{log.text}</span>
                  </div>
                ))}
                <p className="mt-1 border-t border-border/50 px-1 pt-1 text-[9px] text-text-disabled">
                  {t('console.act.historyHint')}
                </p>
              </div>
            )}

            {/* ---------- 最近任务（历史 + 筛选 + 展开） ---------- */}
            {tab === 'jobs' && (
              <div className="flex flex-col gap-1.5">
                {/* 工具栏：类型 + 状态筛选 */}
                <div className="flex flex-wrap items-center gap-1">
                  <button type="button" onClick={() => changeJobFilter('')} className={chip(jobFilter === '')}>
                    {t('console.act.jobFilterAll')}
                  </button>
                  {JOB_KINDS.map((k) => (
                    <button key={k} type="button" onClick={() => changeJobFilter(k)} className={chip(jobFilter === k)}>
                      {k}
                    </button>
                  ))}
                  <span className="mx-1 h-3 w-px bg-border" />
                  {[
                    ['', t('console.act.statusAll')],
                    ['completed', t('console.act.statusOk')],
                    ['failed', t('console.act.statusFail')],
                    ['running', t('console.act.statusRun')],
                  ].map(([v, label]) => (
                    <button key={v} type="button" onClick={() => changeJobStatus(v)} className={chip(jobStatus === v)}>
                      {label}
                    </button>
                  ))}
                  {jobsPage != null && (
                    <span className="ml-auto pr-1 font-mono text-[9px] text-text-disabled">
                      {t('console.act.total', { n: jobsPage.total })}
                    </span>
                  )}
                </div>

                {jobs.length === 0 && <p className="p-2 text-xs text-text-disabled">{t('console.noJobs')}</p>}

                {/* 任务列表：行内展开（GH Actions 语义） */}
                <ul className="space-y-0.5">
                  {jobs.map((job) => {
                    const isOpen = expanded === job.id
                    const err = job.status === 'failed' || job.error != null
                    return (
                      <li key={job.id} className="rounded-sm transition-colors hover:bg-surface-2/40">
                        <button
                          type="button"
                          onClick={() => setExpanded(isOpen ? null : job.id)}
                          className="flex w-full items-center gap-2 px-1.5 py-1 text-left"
                          aria-expanded={isOpen}
                        >
                          <JobStatusDot status={job.status} />
                          <span className={`w-16 shrink-0 text-[10px] font-medium ${err ? 'text-red-400' : 'text-text-primary'}`}>
                            {job.job}
                          </span>
                          <span className="min-w-0 flex-1 text-[10px]">
                            <JobSummaryText job={job} t={t} />
                          </span>
                          <span className="shrink-0 font-mono text-[9px] text-text-disabled">{formatAgo(job.started_at, justNow)}</span>
                          {job.duration_s != null && (
                            <span className="w-12 shrink-0 text-right font-mono text-[9px] text-text-disabled">{job.duration_s}s</span>
                          )}
                          <Icon
                            name="chevron-up"
                            size={10}
                            className={`shrink-0 text-text-disabled transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
                          />
                        </button>
                        {isOpen && <JobDetail jobId={job.id} />}
                      </li>
                    )
                  })}
                </ul>

                {hasMoreJobs && (
                  <button
                    type="button"
                    onClick={() => setJobOffset((o) => o + JOB_PAGE)}
                    className="mx-auto mt-1 rounded-full border border-border px-4 py-1 text-[10px] text-text-secondary transition-colors hover:border-primary hover:text-primary"
                  >
                    {t('console.act.loadMore')}
                  </button>
                )}
              </div>
            )}

            {/* ---------- 系统日志（历史 + 级别 + 搜索） ---------- */}
            {tab === 'system' && (
              <div className="flex flex-col gap-1.5">
                {/* 工具栏：级别 chips + 关键字搜索 */}
                <div className="flex flex-wrap items-center gap-1">
                  {[
                    ['', t('console.act.logLevelAll')],
                    ['INFO', 'INFO'],
                    ['WARNING', 'WARNING'],
                    ['ERROR', 'ERROR'],
                  ].map(([v, label]) => (
                    <button key={v} type="button" onClick={() => changeLogLevel(v)} className={chip(logLevel === v)}>
                      {label}
                    </button>
                  ))}
                  <input
                    type="search"
                    placeholder={t('console.act.logSearchPlaceholder')}
                    onChange={(e) => changeLogQ(e.target.value)}
                    className="ml-auto h-6 w-40 rounded-sm border border-border bg-surface-1 px-2 text-[10px] text-text-primary outline-none placeholder:text-text-disabled focus:border-primary"
                  />
                </div>

                {lines.length === 0 && <p className="p-2 text-text-disabled">{t('console.sysLogsEmpty')}</p>}

                <div className="flex flex-col gap-0.5 font-mono text-[10px] leading-relaxed">
                  {lines.map((line, idx) => (
                    <div key={`${line.ts}-${idx}`} className="flex gap-1.5 rounded-sm px-1 hover:bg-surface-2/40">
                      <span className="w-[52px] shrink-0 select-none text-text-disabled">{line.ts.slice(11, 19)}</span>
                      <span
                        className={`w-14 shrink-0 select-none ${
                          line.level === 'ERROR'
                            ? 'text-red-400'
                            : line.level === 'WARNING'
                              ? 'text-amber-400'
                              : 'text-text-disabled'
                        }`}
                      >
                        {line.level}
                      </span>
                      <span className="w-24 shrink-0 select-none truncate text-text-disabled/70" title={line.logger}>
                        {line.logger}
                      </span>
                      <span className="min-w-0 break-all text-text-secondary">{line.message}</span>
                    </div>
                  ))}
                </div>

                {logHasMore && (
                  <button
                    type="button"
                    onClick={() => void loadMoreLogs()}
                    disabled={logLoadingMore}
                    className="mx-auto mt-1 rounded-full border border-border px-4 py-1 text-[10px] text-text-secondary transition-colors hover:border-primary hover:text-primary disabled:opacity-50"
                  >
                    {logLoadingMore ? '…' : t('console.act.loadMore')}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
