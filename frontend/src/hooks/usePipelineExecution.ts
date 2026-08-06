import { useEffect, useRef } from 'react'
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
  const { data: items = [], isError: itemsError, refetch: refetchItems } = useQuery({
    queryKey: ['pipeline-items'],
    queryFn: () => pipelineApi.items(undefined, 50),
    refetchInterval: pollingInterval,
  })
  const { data: jobs = [] } = useQuery({
    queryKey: ['pipeline-jobs'],
    queryFn: () => pipelineApi.jobs(8),
    refetchInterval: pollingInterval,
  })
  const { data: sources = [] } = useQuery({
    queryKey: ['pipeline-sources'],
    queryFn: pipelineApi.sources,
  })

  const store = useExecutionStore()
  const { step, limit, logs, logSeq } = store.pipeline
  const setPipeline = store.setPipeline

  const runningRef = useRef(false)

  useEventSource(pipelineApi.eventsUrl(), (ev) => {
    const event = JSON.parse((ev as { data: string }).data) as PipelineEvent
    handleEvent(event)
  })

  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: ['pipeline-items'] })
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
    void queryClient.invalidateQueries({ queryKey: ['pipeline-items'] })
    void queryClient.invalidateQueries({ queryKey: ['pipeline-counts'] })
    void queryClient.invalidateQueries({ queryKey: ['pipeline-jobs'] })
    void queryClient.invalidateQueries({ queryKey: ['pipeline-sources'] })
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

  async function act(item: PipelineItem, action: 'approve' | 'reject' | 'retry') {
    try {
      if (action === 'approve') await pipelineApi.approve(item.id)
      else if (action === 'reject') await pipelineApi.reject(item.id)
      else await pipelineApi.retry(item.id)
      refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const running = (status as { running?: boolean } | undefined)?.running ?? false

  return {
    status,
    steps,
    counts,
    items,
    itemsError,
    refetchItems,
    jobs,
    sources,
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
    refresh,
  }
}

export type { PipelineJob }
