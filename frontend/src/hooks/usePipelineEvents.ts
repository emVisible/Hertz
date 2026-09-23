import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { pipelineApi, type PipelineEvent } from '../api'
import { useEventSource } from './useEventSource'
import { useToast } from '../components/ui'
import { useExecutionStore } from '../stores/execution'

/** Pipeline 域 SSE 事件处理。 */
export function usePipelineEvents() {
  const { t } = useTranslation()
  const toast = useToast()
  const queryClient = useQueryClient()
  const setPipeline = useExecutionStore((s) => s.setPipeline)

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
}
