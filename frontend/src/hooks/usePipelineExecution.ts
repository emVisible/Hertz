import { useMemo, useRef } from 'react'
import { useQuery, useQueryClient, type Query } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { api, pipelineApi, type PipelineEvent, type PipelineItem } from '../api'
import { useEventSource } from './useEventSource'
import { useToast } from '../components/ui'
import { useExecutionStore } from '../stores/execution'

// 轮询只是 SSE 的兜底：空闲时 15s 一次，流水线运行中 2s（AXIOM §7.2 性能预算）。
// v5 Query 回调需全泛型才兼容各 useQuery 具体类型
const pollingInterval = (
  query: Query<any, any, any, any>,
): number | false =>
  (query.state.data as { running?: boolean } | undefined)?.running
    ? 2000
    : 15000

/** 批量入参分片（v0.11.8）：后端批量端点 ids max 200（AXIOM 8.1 防大查询）——
 *  全选可超上限触发 422，按 200 切块逐批执行。 */
const BATCH_CHUNK = 200
export function chunkIds(ids: string[]): string[][] {
  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += BATCH_CHUNK) {
    chunks.push(ids.slice(i, i + BATCH_CHUNK))
  }
  return chunks
}

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
  // 自动采集配置（v0.8.1）：间隔分钟（0=关闭）——采集 tab 状态徽章
  const { data: cfg } = useQuery({
    queryKey: ['config'],
    queryFn: () => api.get<{ pipeline_auto_collect_minutes?: number }>('/api/config'),
  })
  const autoCollectMinutes = cfg?.pipeline_auto_collect_minutes ?? 30
  // 采集运维状态（v0.8.2）：监视用
  const { data: collectStatus } = useQuery({
    queryKey: ['pipeline-collect-status'],
    queryFn: pipelineApi.collectStatus,
    refetchInterval: pollingInterval,
  })

  const store = useExecutionStore()
  const { limit, tab, collectProgress, busy } = store.pipeline
  const setPipeline = store.setPipeline

  const runningRef = useRef(false)

  /** 单条操作 busy 包裹（v0.11.3）：点击即标记处理中——按钮转圈 +
   *  全局反馈 + 防重复提交；请求结束（成败）统一清除。
   *  v0.11.4：busy 值升级为 {action, title}——底部「运行状态」折叠条
   *  直接展示「制作中《标题》」，无需页面反查。 */
  function withBusy<T>(item: { id: string; title?: string }, action: string, fn: () => Promise<T>): Promise<T> {
    const entry = { action, title: item.title ?? '' }
    setPipeline({ busy: { ...useExecutionStore.getState().pipeline.busy, [item.id]: entry } })
    return fn().finally(() => {
      const next = { ...useExecutionStore.getState().pipeline.busy }
      delete next[item.id]
      setPipeline({ busy: next })
    })
  }

  /** 批量操作的标题反查（v0.11.4）：hook 内已有全量列表，无需页面参与。 */
  const titleOf = (id: string) => {
    for (const it of [...discoveryAll, ...queueAll, ...stagePublished]) {
      if (it.id === id) return it.title
    }
    return ''
  }

  useEventSource(pipelineApi.eventsUrl(), (ev) => {
    const event = JSON.parse((ev as { data: string }).data) as PipelineEvent
    handleEvent(event)
  })

  function handleEvent(event: PipelineEvent) {
    if (event.type === 'job_step') {
      // 明细（v0.3.0，参考原项目 job_summary）：collect 显示采集/入库/跳过
      if (event.step === 'collect') {
        // v0.8.2 可视化进度：job_step collect 一次带全源明细
        const sources = event.sources as
          | Array<{ channel: string; collected?: number; inserted?: number; cooldown_s?: number; error?: string }>
          | undefined
        if (sources) setPipeline({ collectProgress: sources })
      }
    } else if (event.type === 'item') {
      // v0.10.1 异步队列：后台任务每完成一条立即刷新列表与计数（此前
      // 同步批处理完成后才一次性刷新，看不到逐个进度）
      void queryClient.invalidateQueries({ queryKey: ['pipeline-queue'] })
      void queryClient.invalidateQueries({ queryKey: ['pipeline-counts'] })
    } else if (event.type === 'job_done') {
      const failed = event.status === 'failed'
      // 冷却（v0.3.5）：源被拒后的静默分支——不算 ✓，标 ⚠ 提示原因
      const cooling = Boolean(event.summary?.cooldown_s)
      const empty = Boolean(event.summary?.empty)
      // 完成摘要（v0.3.0，参考原项目 job_summary 中文摘要）
      const s = event.summary
      let summary = ''
      if (event.job === 'collect') {
        summary = t('console.collectSummary', { n: s?.collected ?? 0, ins: s?.inserted ?? 0, sk: s?.skipped ?? 0 })
        if (s?.failed_sources) summary += ` ⚠ ${s.failed_sources} 个源失败`
        if (empty) summary += ' ⚠ 源返回空，已进入冷却'
        if (cooling) summary += ` ⏳ 源冷却中（${Math.ceil(Number(s?.cooldown_s ?? 0))}s）`
      } else if (s) {
        const parts = []
        if (s.processed !== undefined) parts.push(t('console.processedItems', { n: s.processed }))
        if (s.ok !== undefined) parts.push(`成功 ${s.ok}`)
        if (s.skipped !== undefined) parts.push(`跳过 ${s.skipped}（冷却）`)
        if (s.rejected !== undefined) parts.push(`拒绝 ${s.rejected}`)
        if (s.failed !== undefined) parts.push(`失败 ${s.failed}`)
        if (parts.length) summary = parts.join(' · ')
        if (!summary && (s.processed ?? 0) === 0) {
          summary = t('console.noPending')
        }
      }
      void queryClient.invalidateQueries({ queryKey: ['pipeline-jobs'] })
      void queryClient.invalidateQueries({ queryKey: ['pipeline-queue'] })
      void queryClient.invalidateQueries({ queryKey: ['pipeline-counts'] })
      if (failed) toast(event.error ?? `${event.job} failed`, 'error')
      else if (empty) toast(t('console.collectEmpty'), 'warning')
      else if (cooling) toast(t('console.collectCooling'), 'warning')
    }
  }

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ['pipeline-stage'] })
    // v0.8.9 Bug 修复：pipeline-queue 是 stageQueued/stageDownloaded/stageScored
    // 的数据源——此前漏 invalidate，制作/评分/下载后审核列表要等 15s 轮询才出现
    void queryClient.invalidateQueries({ queryKey: ['pipeline-queue'] })
    void queryClient.invalidateQueries({ queryKey: ['pipeline-counts'] })
    void queryClient.invalidateQueries({ queryKey: ['pipeline-jobs'] })
    void queryClient.invalidateQueries({ queryKey: ['pipeline-sources'] })
    // 失败分类看板 / 供给告警 / 内容日历：操作后即时刷新（§7.5 缓存症状）
    void queryClient.invalidateQueries({ queryKey: ['pipeline-failures'] })
    void queryClient.invalidateQueries({ queryKey: ['pipeline-supply'] })
    void queryClient.invalidateQueries({ queryKey: ['pipeline-calendar'] })
  }

  const setLimit = (v: number) => setPipeline({ limit: v })

  /** 单条评分（v0.3.5，预处理手动评分按钮）。 */
  async function scoreOne(item: PipelineItem) {
    try {
      await withBusy(item, 'score', () => pipelineApi.score(item.id))
      refresh()
      toast(t('console.scored'), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  /** 单条下载（v0.8.6 评分先行，预处理手动下载按钮）。 */
  async function downloadOne(item: PipelineItem) {
    try {
      await withBusy(item, 'download', () => pipelineApi.download(item.id))
      refresh()
      toast(t('console.downloaded'), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  /** 单条直下（v0.11.10）：未评分条目绕过评分直接下载——省 API 余额场景。 */
  async function downloadOneDirect(item: PipelineItem) {
    try {
      await withBusy(item, 'download', () => pipelineApi.download(item.id, true))
      refresh()
      toast(t('console.downloaded'), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  /** 批量评分（v0.3.5，预处理批量操作条）。 */
  async function scoreBatch() {
    await runStepOnly('score')
  }

  /** 批量直下（v0.11.10，预处理「直接下载」按钮）：全部未评分条目
   *  绕过评分直接下载（异步队列，进度经 SSE/job 轮询）。 */
  async function downloadBatchUnscored() {
    await runStepOnly('download', '', true)
  }

  /** 单条制作（v0.3.4，预处理「制作」按钮）。 */
  async function produceOne(item: PipelineItem) {
    try {
      // v0.11.3：开始即反馈（长任务）——按钮转圈 + 横幅 + 终端 job_step
      toast(t('console.produceStart', { title: item.title }), 'info')
      await withBusy(item, 'produce', () => pipelineApi.produce(item.id))
      refresh()
      toast(t('console.produceOneDone'), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  /** 取消制作（wave11）：点错/视频过长省资源——后端产线检查点命中即中止，
   *  条目回滚 downloaded（不标失败）。busy 状态保持到制作请求返回为止。 */
  async function cancelProduceOne(item: PipelineItem) {
    try {
      await pipelineApi.cancelProduce(item.id)
      toast(t('console.produceCancelled', { title: item.title }), 'info')
      // 制作请求返回（检查点命中）后刷新——invalidate 提前发无害
      refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  /** 批量制作（v0.3.4，预处理 menu 批处理入口）。 */
  async function produceBatch() {
    await runStepOnly('produce')
  }

  async function runStepOnly(stepName: string, channel = '', unscored = false) {
    if (runningRef.current) return
    runningRef.current = true
    try {
      // v0.10.1 异步队列：run 端点立即返回 queued，任务后台执行——进度经
      // SSE（job_step/item/job_done）实时刷新，不再等待整个批次完成。
      // v0.11.10：unscored 仅对 download 生效（绕过评分直接下载）。
      await pipelineApi.run(stepName, limit, channel, unscored)
      toast(t('console.jobQueued', { step: stepName }), 'success')
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

  async function act(
    item: PipelineItem,
    action: 'approve' | 'reject' | 'retry' | 'requeue' | 'retranslate',
  ) {
    try {
      if (action === 'approve') {
        await withBusy(item, 'approve', () => pipelineApi.approve(item.id))
        toast(t('console.approvedHint'), 'success')
      } else if (action === 'reject') {
        await withBusy(item, 'reject', () => pipelineApi.reject(item.id))
        toast(t('console.rejectedHint'), 'success')
      } else if (action === 'requeue') {
        await withBusy(item, 'requeue', () => pipelineApi.requeue(item.id))
        toast(t('console.requeuedHint'), 'success')
      } else if (action === 'retranslate') {
        toast(t('console.retranslateStart', { title: item.title }), 'info')
        await withBusy(item, 'retranslate', () => pipelineApi.retranslate(item.id))
        toast(t('console.retranslatedHint'), 'success')
      } else {
        await withBusy(item, 'retry', () => pipelineApi.retry(item.id))
        toast(t('console.retriedHint'), 'success')
      }
      refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  /** 停止当前任务（v0.8.2 采集运维：终止运行中的批次）。 */
  async function stop() {
    try {
      await pipelineApi.cancel()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  /** 批量操作（v0.4 A2）：多选后一次处理——成功/失败计数 + 逐条错误。
   *  v0.11.8：全选可超后端 200 上限（AXIOM 8.1 防大查询）——按 200 分批
   *  串行执行并聚合 ok/failed，避免 422 validation error。 */
  async function batchAction(
    action: 'approve' | 'reject' | 'back_to_prep' | 'requeue',
    ids: string[],
  ) {
    if (ids.length === 0) return
    const busyKey = action === 'back_to_prep' ? 'backToPrep' : action
    try {
      const busyPatch = { ...useExecutionStore.getState().pipeline.busy }
      for (const id of ids) busyPatch[id] = { action: busyKey, title: titleOf(id) }
      setPipeline({ busy: busyPatch })
      let ok = 0
      const failed: Array<{ id: string; error: string }> = []
      for (const chunk of chunkIds(ids)) {
        const res = await pipelineApi.batch(action, chunk)
        ok += res.ok
        failed.push(...res.failed)
      }
      refresh()
      const hint =
        failed.length > 0
          ? t('console.batchDoneWithErrors', { ok, failed: failed.length })
          : t('console.batchDone', { n: ok })
      toast(hint, failed.length > 0 ? 'warning' : 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      const next = { ...useExecutionStore.getState().pipeline.busy }
      for (const id of ids) delete next[id]
      setPipeline({ busy: next })
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

  async function publishItem(item: PipelineItem, selfmade = false, target = '', now = false) {
    try {
      toast(t('console.publishStart', { title: item.title }), 'info')
      const res = await withBusy(item, 'publish', () =>
        pipelineApi.publish(item.id, selfmade, target, now),
      )
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

  /** 随机抽帧封面（v0.11.5）：视频内随机取一帧 → 替换封面，点击可反复换。 */
  async function randomCover(item: PipelineItem) {
    try {
      await withBusy(item, 'cover', () => pipelineApi.randomCover(item.id))
      refresh()
      toast(t('console.coverRandom'), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  /** 入队/出队（v0.12）：holding=预发布｜ready=发布队列｜''=出队 */
  async function enqueueItem(item: PipelineItem, phase: '' | 'holding' | 'ready') {
    try {
      await withBusy(item, 'enqueue', () => pipelineApi.enqueue(item.id, phase))
      refresh()
      toast(
        phase === 'holding'
          ? t('console.queueHoldingOk')
          : phase === 'ready'
            ? t('console.queueReadyOk')
            : t('console.queueLeaveOk'),
        'success',
      )
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
      await withBusy(item, 'backToPrep', () => pipelineApi.backToPrep(item.id))
      refresh()
      toast(t('console.backToPrepDone'), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }


  /** 生产方式批量设置（v0.3.3，预处理人工选择）。 */
  async function setProduceOptions(items: PipelineItem[], options: Record<string, boolean>) {
    // v0.8.4：生产方式点击已有即时视觉反馈（本地 state）——不再 toast，避免噪音
    try {
      await pipelineApi.setProduceOptions(items.map((i) => i.id), options)
      refresh()
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

  // 备用库（wave10）：归档条目——删除入口收口异常区
  const { data: archivedItems = [] } = useQuery({
    queryKey: ['pipeline-archived'],
    queryFn: () => pipelineApi.archivedItems(200),
    refetchInterval: pollingInterval,
  })

  /** 归档（wave10）：磁盘清理 + 数据清洗，条目进备用库。
   *  v0.11.8：全选超后端 200 上限——分批聚合。 */
  async function archiveItems(items: PipelineItem[]) {
    try {
      const ids = items.map((i) => i.id)
      let ok = 0
      for (const chunk of chunkIds(ids)) {
        const res = await pipelineApi.archive(chunk)
        ok += res.ok
      }
      await queryClient.invalidateQueries({ queryKey: ['pipeline-archived'] })
      refresh()
      toast(t('console.archiveDone', { n: ok }), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  /** 恢复（wave10）：清除 archived 标记回到原状态列表。
   *  v0.11.8：分批聚合。 */
  async function unarchiveItems(items: PipelineItem[]) {
    try {
      const ids = items.map((i) => i.id)
      let ok = 0
      for (const chunk of chunkIds(ids)) {
        const res = await pipelineApi.unarchive(chunk)
        ok += res.ok
      }
      await queryClient.invalidateQueries({ queryKey: ['pipeline-archived'] })
      refresh()
      toast(t('console.unarchiveDone', { n: ok }), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  /** 彻底删除（wave10，不可逆）：仅归档条目，物理删行。
   *  v0.11.8：分批聚合。 */
  async function purgeItems(items: PipelineItem[]) {
    const n = items.length
    if (!window.confirm(t('console.purgeConfirm', { n }))) return
    try {
      const ids = items.map((i) => i.id)
      let ok = 0
      for (const chunk of chunkIds(ids)) {
        const res = await pipelineApi.purge(chunk)
        ok += res.ok
      }
      await queryClient.invalidateQueries({ queryKey: ['pipeline-archived'] })
      toast(t('console.purgeDone', { n: ok }), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const running = (status as { running?: boolean } | undefined)?.running ?? false

  return {
    status,
    counts,
    busy,
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
    act,
    batchAction,
    setPublishStats,
    saveMeta,
    publishItem,
    publishStatus,
    autoCollectMinutes,
    collectStatus,
    collectProgress,
    stop,
    uploadCover,
    randomCover,
    enqueueItem,
    retryClass,
    backToPrep,
    rescheduleExpired,
    setProduceOptions,
    archivedItems,
    archiveItems,
    unarchiveItems,
    purgeItems,
    produceOne,
    cancelProduceOne,
    produceBatch,
    scoreOne,
    scoreBatch,
    downloadBatchUnscored,
    downloadOne,
    downloadOneDirect,
    runStep,
    refresh,
  }
}
