import { useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { pipelineApi, type FocusPatch, type PipelineItem } from '../api'
import { useToast } from '../components/ui'
import { useExecutionStore } from '../stores/execution'

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

interface PipelineActionsContext {
  discoveryAll: PipelineItem[]
  queueAll: PipelineItem[]
  stagePublished: PipelineItem[]
  limit: number
}

/** Pipeline 域操作函数。 */
export function usePipelineActions(ctx: PipelineActionsContext) {
  const { t } = useTranslation()
  const toast = useToast()
  const queryClient = useQueryClient()
  const setPipeline = useExecutionStore((s) => s.setPipeline)
  const { discoveryAll, queueAll, stagePublished, limit } = ctx

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

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ['pipeline-stage'] })
    // v0.8.9 Bug 修复：pipeline-queue 是 stageQueued/stageDownloaded/stageScored
    // 的数据源——此前漏 invalidate，制作/评分/下载后审核列表要等 15s 轮询才出现
    void queryClient.invalidateQueries({ queryKey: ['pipeline-queue'] })
    void queryClient.invalidateQueries({ queryKey: ['pipeline-counts'] })
    void queryClient.invalidateQueries({ queryKey: ['pipeline-jobs'] })
    void queryClient.invalidateQueries({ queryKey: ['pipeline-sources'] })
    // 失败分类看板 / 供给告警：操作后即时刷新（§7.5 缓存症状）
    void queryClient.invalidateQueries({ queryKey: ['pipeline-failures'] })
    void queryClient.invalidateQueries({ queryKey: ['pipeline-supply'] })
    // v0.34 B：看板按天取数（`['pipeline-board', day]`，前缀匹配覆盖所有天）。
    // 内容日历的 invalidate 随日历视图一起退役——端点还在，只是界面不再读它。
    void queryClient.invalidateQueries({ queryKey: ['pipeline-board'] })
  }

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
      const res = await withBusy(item, 'download', () => pipelineApi.download(item.id))
      refresh()
      // 跳过的条目（CDN 冷却/熔断、空壳隔离）不会进 downloaded——硬报「已下载」
      // 就是让用户去「已下载未加工」扑空，而且找不到原因（实测于直下链路）。
      if (res.outcome === 'skipped') toast(t('console.downloadSkipped'), 'warning')
      else toast(t('console.downloaded'), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  /** 单条直下（v0.11.10）：未评分条目绕过评分直接下载——省 API 余额场景。 */
  async function downloadOneDirect(item: PipelineItem) {
    try {
      const res = await withBusy(item, 'download', () => pipelineApi.download(item.id, true))
      refresh()
      if (res.outcome === 'skipped') toast(t('console.downloadSkipped'), 'warning')
      else toast(t('console.downloaded'), 'success')
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

  /** 今日关注（v0.34 D-218）：捞入 / 移出 / 改备注的**唯一**界面写点。
   *  看板与流水线共用这一个函数——从前看板自带一份 mutation，两边各写一份就会漂成
   *  两套失效逻辑（看板的 `['pipeline-board']` 与流水线的 `pipeline-stage` 只被一边清）。
   *  成功不弹 toast：点完列表自己就变了，弹字是噪音；失败必须弹，否则是静默不写。 */
  async function setFocus(item: PipelineItem, patch: FocusPatch) {
    try {
      await pipelineApi.setFocus(item.id, patch)
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

  /** 入队/出队的 hook 随「入队」按钮一起退役（v0.34 B，用户定档：全部手动发）。
   *  撤的是**界面写点**：后端 `POST /items/{id}/queue` 与 `queue_phase` 字段、
   *  `auto_publish` 的槽位机制一律保留——要开无人值守发布，走 API 或 Telegram 写相位。 */

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

  return {
    act,
    setFocus,
    batchAction,
    setPublishStats,
    saveMeta,
    publishItem,
    uploadCover,
    randomCover,
    retryClass,
    backToPrep,
    rescheduleExpired,
    setProduceOptions,
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
    stop,
    refresh,
  }
}
