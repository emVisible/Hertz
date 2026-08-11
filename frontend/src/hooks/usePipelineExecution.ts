import { useEffect, useMemo, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { pipelineApi, type PipelineEvent, type PipelineItem } from '../api'
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
  const { data: counts = {} } = useQuery({
    queryKey: ['pipeline-counts'],
    queryFn: pipelineApi.counts,
    refetchInterval: pollingInterval,
  })
  // 阶段队列（v0.3.5）：发现队列独立查询——避免 discovered 占满 limit 截断
  // 已下载/已评分/待审核等旧序条目（seq desc 排序下老数据被 200 截断的 bug）
  const { data: discoveryAll = [], isError: stageError, refetch: refetchStage } = useQuery({
    queryKey: ['pipeline-stage'],
    // v0.3.12：349 条发现队列此前被 200 截断——提到 500
    queryFn: () => pipelineApi.items('discovered', 500),
    refetchInterval: pollingInterval,
  })
  const { data: queueAll = [] } = useQuery({
    queryKey: ['pipeline-queue'],
    queryFn: () =>
      pipelineApi.items('downloaded,scored,queued,approved,failed,rejected', 500),
    refetchInterval: pollingInterval,
  })
  // 发布历史（v0.3.8）：已发布内容完整回到发布列表——不再只有最近 10 条
  const { data: stagePublished = [] } = useQuery({
    queryKey: ['pipeline-stage', 'published'],
    queryFn: () => pipelineApi.items('published', 100),
    refetchInterval: pollingInterval,
  })
  const stageGroups = useMemo(() => {
    const g: Record<string, PipelineItem[]> = {}
    for (const it of queueAll) {
      ;(g[it.status] ??= []).push(it)
    }
    return g
  }, [queueAll])
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
  // 发布健康状态（v0.3.8）：目标 + B 站 cookie 就绪度——noop 目标下发布仅记录意图
  const { data: publishStatus } = useQuery({
    queryKey: ['pipeline-publish-status'],
    queryFn: pipelineApi.publishStatus,
    refetchInterval: pollingInterval,
  })

  const store = useExecutionStore()
  const { limit, logSeq, tab } = store.pipeline
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
      // 明细（v0.3.0，参考原项目 job_summary）：collect 显示采集/入库/跳过
      if (event.step === 'collect') {
        const details = [
          t('console.collected', { n: event.collected ?? event.count ?? 0 }),
          t('console.inserted', { n: event.inserted ?? 0 }),
          t('console.skipped', { n: event.skipped ?? 0 }),
        ]
        if (event.cooldown_s) details.push(`⏳ ${Math.ceil(event.cooldown_s)}s`)
        appendLog(`[collect] ${details.join(' · ')}`, 'job')
      } else {
        appendLog(`[${event.step}] ${t('console.processed', { n: event.count ?? 0 })}`, 'job')
      }
    } else if (event.type === 'item') {
      appendLog(`${t('console.item')} ${event.status}${event.error ? `: ${event.error}` : ''}`, event.status === 'rejected' || event.status === 'failed' ? 'done' : 'item')
    } else if (event.type === 'job_done') {
      const failed = event.status === 'failed'
      // 冷却（v0.3.5）：源被拒后的静默分支——不算 ✓，标 ⚠ 提示原因
      const cooling = Boolean(event.summary?.cooldown_s)
      const empty = Boolean(event.summary?.empty)
      // 完成摘要（v0.3.0，参考原项目 job_summary 中文摘要）
      const s = event.summary
      let summary = ''
      if (event.job === 'collect') {
        summary = `采集 ${s?.collected ?? 0} 条 · 新入库 ${s?.inserted ?? 0} · 跳过 ${s?.skipped ?? 0}`
        if (s?.failed_sources) summary += ` ⚠ ${s.failed_sources} 个源失败`
        if (empty) summary += ' ⚠ 源返回空，已进入冷却'
        if (cooling) summary += ` ⏳ 源冷却中（${Math.ceil(Number(s?.cooldown_s ?? 0))}s）`
      } else if (s) {
        const parts = []
        if (s.processed !== undefined) parts.push(`处理 ${s.processed} 项`)
        if (s.ok !== undefined) parts.push(`成功 ${s.ok}`)
        if (s.skipped !== undefined) parts.push(`跳过 ${s.skipped}（冷却）`)
        if (s.rejected !== undefined) parts.push(`拒绝 ${s.rejected}`)
        if (s.failed !== undefined) parts.push(`失败 ${s.failed}`)
        if (parts.length) summary = parts.join(' · ')
        if (!summary && (s.processed ?? 0) === 0) {
          summary = t('console.noPending')
        }
      }
      // 运行前后数据差异（v0.3.5）：discovered −1 · downloaded +1 等
      const delta = (s?.delta ?? {}) as Record<string, number>
      const deltaText = Object.entries(delta)
        .filter(([, n]) => n !== 0)
        .map(([status, n]) => `${t(`console.${status}`) ?? status} ${n > 0 ? '+' : ''}${n}`)
        .join(' · ')
      appendLog(`── [${event.job}] ${failed ? '✗' : empty || cooling ? '⚠' : '✓'}${summary ? ` ${summary}` : ''}${deltaText ? `  ${deltaText}` : ''}${event.error ? `: ${event.error}` : ''} ──`, 'done')
      void queryClient.invalidateQueries({ queryKey: ['pipeline-jobs'] })
      if (failed) toast(event.error ?? `${event.job} failed`, 'error')
      else if (empty) toast(t('console.collectEmpty'), 'warning')
      else if (cooling) toast(t('console.collectCooling'), 'warning')
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

  const setLimit = (v: number) => setPipeline({ limit: v })


  /** 一键采集+下载（v0.3.5，快捷链）。 */
  async function collectAndDownload() {
    if (runningRef.current) return
    runningRef.current = true
    try {
      await pipelineApi.run('collect', limit)
      await pipelineApi.run('download', limit)
      refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      runningRef.current = false
    }
  }

  /** 单条评分（v0.3.5，预处理手动评分按钮）。 */
  async function scoreOne(item: PipelineItem) {
    try {
      await pipelineApi.score(item.id)
      refresh()
      toast(t('console.scored'), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  /** 批量评分（v0.3.5，预处理批量操作条）。 */
  async function scoreBatch() {
    await runStepOnly('score')
  }

  /** 单条制作（v0.3.4，预处理「制作」按钮）。 */
  async function produceOne(item: PipelineItem) {
    try {
      await pipelineApi.produce(item.id)
      refresh()
      toast(t('console.produceOneDone'), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  /** 批量制作（v0.3.4，预处理 menu 批处理入口）。 */
  async function produceBatch() {
    await runStepOnly('produce')
  }

  async function runStepOnly(stepName: string, channel = '') {
    if (runningRef.current) return
    runningRef.current = true
    try {
      await pipelineApi.run(stepName, limit, channel)
      refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      runningRef.current = false
    }
  }

  /** 采集/下载单步执行（v0.3.5，采集 menu 大按钮）。 */
  async function runStep(stepName: string, channel = '') {
    await runStepOnly(stepName, channel)
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

  /** 批量操作（v0.4 A2）：多选后一次处理——成功/失败计数 + 逐条错误。 */
  async function batchAction(
    action: 'approve' | 'reject' | 'back_to_prep' | 'requeue',
    ids: string[],
  ) {
    if (ids.length === 0) return
    try {
      const res = await pipelineApi.batch(action, ids)
      refresh()
      const hint =
        res.failed.length > 0
          ? t('console.batchDoneWithErrors', { ok: res.ok, failed: res.failed.length })
          : t('console.batchDone', { n: res.ok })
      toast(hint, res.failed.length > 0 ? 'warning' : 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  /** 发布数据补录（v0.4 C1）：自动回捞失败时手动填播放/互动（空格分隔）。 */
  async function setPublishStats(item: PipelineItem) {
    const raw = window.prompt(t('console.statsPrompt'))
    if (raw === null) return
    const parts = raw.trim().split(/\s+/).map(Number)
    if (parts.length !== 5 || parts.some((n) => Number.isNaN(n))) {
      toast(t('console.statsPromptInvalid'), 'warning')
      return
    }
    try {
      const [view, like, favorite, comment, share] = parts
      await pipelineApi.setPublishStats(item.id, { view, like, favorite, comment, share })
      refresh()
      toast(t('console.statsSaved'), 'success')
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

  async function publishItem(item: PipelineItem, selfmade = false, target = '') {
    try {
      const res = await pipelineApi.publish(item.id, selfmade, target)
      refresh()
      // v0.3.8：noop 目标只记录意图——toast 明确警示，避免「点了发布=已上 B 站」误解
      if (res.noop) {
        toast(t('console.publishNoop'), 'warning')
      } else {
        toast(t('console.published'), 'success')
      }
      // v0.4 E3：桌面系统通知（Electron；浏览器环境静默跳过）
      window.electron?.notifyPublish(item.title, !res.noop)
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
      window.electron?.notifyPublish(item.title, false)
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

  /** 审核打回预处理（v0.3.9 相邻双向）：queued → scored，重新制作。 */
  async function backToPrep(item: PipelineItem) {
    try {
      await pipelineApi.backToPrep(item.id)
      refresh()
      toast(t('console.backToPrepDone'), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  /** 预处理打回采集（v0.3.9 相邻双向）：downloaded/scored → discovered，重新下载。 */
  async function backToCollect(item: PipelineItem) {
    try {
      await pipelineApi.backToCollect(item.id)
      refresh()
      toast(t('console.backToCollectDone'), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  /** 生产方式批量设置（v0.3.3，预处理人工选择）。 */
  async function setProduceOptions(items: PipelineItem[], options: Record<string, boolean>) {
    try {
      const res = await pipelineApi.setProduceOptions(items.map((i) => i.id), options)
      refresh()
      toast(t('console.produceSaved', { n: res.updated }), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  /** 过期排期自动重排（v0.2.7）：进入审核时调用。 */
  async function rescheduleExpired() {
    try {
      const res = await pipelineApi.rescheduleExpired()
      if (res.updated > 0) {
        toast(t('console.rescheduleUpdated', { n: res.updated }), 'info')
        refresh()
      }
    } catch {
      /* 静默：重排失败不阻塞审核浏览 */
    }
  }

  const running = (status as { running?: boolean } | undefined)?.running ?? false

  return {
    status,
    counts,
    stageError,
    refetchStage,
    stageDiscovered: discoveryAll,
    stageDownloaded: stageGroups.downloaded ?? [],
    stageScored: stageGroups.scored ?? [],
    stageQueued: stageGroups.queued ?? [],
    stageApproved: stageGroups.approved ?? [],
    stageFailed: stageGroups.failed ?? [],
    stageRejected: stageGroups.rejected ?? [],
    stagePublished,
    tab,
    setTab: (v: string) => setPipeline({ tab: v }),
    sources,
    failures,
    supplyWarnings: supply.warnings,
    limit,
    setLimit,
    running,
    clearLogs: () => store.resetPipelineLogs(),
    act,
    batchAction,
    setPublishStats,
    saveMeta,
    publishItem,
    publishStatus,
    uploadCover,
    retryClass,
    backToPrep,
    backToCollect,
    rescheduleExpired,
    setProduceOptions,
    produceOne,
    produceBatch,
    collectAndDownload,
    scoreOne,
    scoreBatch,
    runStep,
    refresh,
  }
}
