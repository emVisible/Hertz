import { useEffect, useMemo, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { pipelineApi, type PipelineEvent, type PipelineItem, type PipelineJob } from '../api'
import { useEventSource } from './useEventSource'
import { useToast } from '../components/ui'
import { useExecutionStore } from '../stores/execution'
import type { LogLine } from '../components/execution'

export interface PipelineLog extends LogLine {
  kind: 'job' | 'item' | 'done' | 'system'
}

// 轮询只是 SSE 的兜底：空闲时 15s 一次，流水线运行中 2s（AXIOM §7.2 性能预算）。
const pollingInterval = (query: unknown): number | false =>
  (query as { state?: { data?: { running?: boolean } } })?.state?.data?.running ? 2000 : 15000

/** Pipeline 域执行状态（从 ConsolePage 抽取，逻辑零改动）。 */
export function usePipelineExecution() {
  const { t } = useTranslation()
  const toast = useToast()
  const queryClient = useQueryClient()

  const { data: status } = useQuery({
    queryKey: ['pipeline-status'],
    queryFn: pipelineApi.status,
    refetchInterval: 5000,
  })
  const { data: steps = [] } = useQuery({
    queryKey: ['pipeline-steps'],
    queryFn: () => pipelineApi.steps().then((s) => s.steps),
  })
  const { data: counts = {} } = useQuery({
    queryKey: ['pipeline-counts'],
    queryFn: pipelineApi.counts,
    refetchInterval: pollingInterval,
  })
  // 阶段队列：单查询拉取全部状态（wave13 多状态合并，轮询 7→1 个请求），
  // 前端按状态分组派生各阶段列表
  const { data: stageAll = [], isError: stageError, refetch: refetchStage } = useQuery({
    queryKey: ['pipeline-stage'],
    queryFn: () =>
      pipelineApi.items('discovered,downloaded,scored,queued,approved,failed,rejected', 200),
    refetchInterval: pollingInterval,
  })
  // 最近发布历史（发布页独立查询）
  const { data: stagePublished = [] } = useQuery({
    queryKey: ['pipeline-stage', 'published'],
    queryFn: () => pipelineApi.items('published', 10),
    refetchInterval: pollingInterval,
  })
  const stageGroups = useMemo(() => {
    const g: Record<string, PipelineItem[]> = {}
    for (const it of stageAll) {
      ;(g[it.status] ??= []).push(it)
    }
    return g
  }, [stageAll])
  const { data: jobs = [] } = useQuery({
    queryKey: ['pipeline-jobs'],
    queryFn: () => pipelineApi.jobs(8),
    refetchInterval: pollingInterval,
  })
  const { data: sources = [] } = useQuery({
    queryKey: ['pipeline-sources'],
    queryFn: pipelineApi.sources,
  })
  // 失败分类看板（v0.2.1）：failed 按类聚合，同类批量重试
  const { data: failures = {} } = useQuery({
    queryKey: ['pipeline-failures'],
    queryFn: pipelineApi.failures,
    refetchInterval: pollingInterval,
  })
  // 供给告警（漏斗空 / 供给偏紧 / 采集源失联）
  const { data: supply = { warnings: [] } } = useQuery({
    queryKey: ['pipeline-supply'],
    queryFn: pipelineApi.supply,
    refetchInterval: pollingInterval,
  })

  const store = useExecutionStore()
  const { step, limit, logs, logSeq, tab } = store.pipeline
  const setPipeline = store.setPipeline

  const runningRef = useRef(false)

  useEventSource(pipelineApi.eventsUrl(), (ev) => {
    const event = JSON.parse((ev as { data: string }).data) as PipelineEvent
    handleEvent(event)
  })

  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: ['pipeline-stage'] })
    void queryClient.invalidateQueries({ queryKey: ['pipeline-counts'] })
  }, [status?.running, queryClient])

  function appendLog(text: string, kind: PipelineLog['kind']) {
    const now = new Date()
    const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`
    setPipeline({
      logs: [...useExecutionStore.getState().pipeline.logs.slice(-499), { id: logSeq, time, text, kind }],
      logSeq: logSeq + 1,
    })
  }

  function handleEvent(event: PipelineEvent) {
    if (event.type === 'job_step') {
      const text = `[${event.step}] ${event.step === 'collect' ? `${t('console.collected', { n: event.count ?? 0 })}` : `${t('console.processed', { n: event.count ?? 0 })}`}`
      appendLog(text, 'job')
    } else if (event.type === 'item') {
      appendLog(`${t('console.item')} ${event.status}${event.error ? `: ${event.error}` : ''}`, event.status === 'rejected' || event.status === 'failed' ? 'done' : 'item')
    } else if (event.type === 'job_done') {
      const failed = event.status === 'failed'
      appendLog(`── [${event.job}] ${failed ? '✗' : '✓'}${event.error ? `: ${event.error}` : ''} ──`, 'done')
      void queryClient.invalidateQueries({ queryKey: ['pipeline-jobs'] })
      if (failed) toast(event.error ?? `${event.job} failed`, 'error')
    }
  }

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ['pipeline-stage'] })
    void queryClient.invalidateQueries({ queryKey: ['pipeline-counts'] })
    void queryClient.invalidateQueries({ queryKey: ['pipeline-jobs'] })
    void queryClient.invalidateQueries({ queryKey: ['pipeline-sources'] })
    // 失败分类看板 / 供给告警 / 内容日历：操作后即时刷新（§7.5 缓存症状）
    void queryClient.invalidateQueries({ queryKey: ['pipeline-failures'] })
    void queryClient.invalidateQueries({ queryKey: ['pipeline-supply'] })
    void queryClient.invalidateQueries({ queryKey: ['pipeline-calendar'] })
  }

  const setStep = (v: string) => setPipeline({ step: v })
  const setLimit = (v: number) => setPipeline({ limit: v })

  async function run() {
    if (!step || runningRef.current) return
    runningRef.current = true
    try {
      if (step === 'chain') {
        await pipelineApi.chain(limit)
      } else {
        await pipelineApi.run(step, limit)
      }
      refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      runningRef.current = false
    }
  }

  async function stop() {
    try {
      await pipelineApi.cancel()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  async function act(item: PipelineItem, action: 'approve' | 'reject' | 'retry' | 'requeue') {
    try {
      if (action === 'approve') {
        await pipelineApi.approve(item.id)
        toast(t('console.approvedHint'), 'success')
      } else if (action === 'reject') {
        await pipelineApi.reject(item.id)
        toast(t('console.rejectedHint'), 'success')
      } else if (action === 'requeue') {
        await pipelineApi.requeue(item.id)
        toast(t('console.requeuedHint'), 'success')
      } else {
        await pipelineApi.retry(item.id)
        toast(t('console.retriedHint'), 'success')
      }
      refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  async function saveMeta(item: PipelineItem, meta: Record<string, string | number | null>) {
    try {
      await pipelineApi.updateMeta(item.id, meta)
      refresh()
      toast(t('console.metaSaved'), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  async function publishItem(item: PipelineItem, selfmade = false) {
    try {
      await pipelineApi.publish(item.id, selfmade)
      refresh()
      toast(t('console.published'), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  /** 上传替换封面（v0.2.6）：审核卡换封面。 */
  async function uploadCover(item: PipelineItem, file: File) {
    try {
      await pipelineApi.uploadCover(item.id, file)
      refresh()
      toast(t('console.coverSaved'), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  /** 同类批量重试（失败分类看板）：批量副作用，先确认（AXIOM §13.1）。 */
  async function retryClass(cls: string, n: number) {
    if (!window.confirm(t('console.retryClassConfirm', { cls, n }))) return
    try {
      const res = await pipelineApi.retryClass(cls)
      refresh()
      toast(t('console.retriedClass', { n: res.requeued }), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const running = (status as { running?: boolean } | undefined)?.running ?? false

  return {
    status,
    steps,
    counts,
    stageError,
    refetchStage,
    stageDiscovered: stageGroups.discovered ?? [],
    stageDownloaded: stageGroups.downloaded ?? [],
    stageScored: stageGroups.scored ?? [],
    stageQueued: stageGroups.queued ?? [],
    stageApproved: stageGroups.approved ?? [],
    stageFailed: stageGroups.failed ?? [],
    stageRejected: stageGroups.rejected ?? [],
    stagePublished,
    tab,
    setTab: (v: string) => setPipeline({ tab: v }),
    jobs,
    sources,
    failures,
    supplyWarnings: supply.warnings,
    step,
    setStep,
    limit,
    setLimit,
    running,
    logs,
    clearLogs: () => store.resetPipelineLogs(),
    run,
    stop,
    act,
    saveMeta,
    publishItem,
    uploadCover,
    retryClass,
    refresh,
  }
}

export type { PipelineJob }
