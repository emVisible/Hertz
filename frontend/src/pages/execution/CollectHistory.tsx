import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { pipelineApi, type CollectSourceRun, type PipelineJob } from '../../api'
import { Icon } from '../../components/ui'

/** 采集历史轮次（v0.8.7）：采集卡下迷你时间线——最近 N 轮结果一眼可见。
 *  逐源明细（channel × 采集/入库/错误/冷却）在活动面板「最近任务」行内展开完整查看。 */
export function CollectHistory({ limit = 8 }: { limit?: number }) {
  const { t } = useTranslation()
  const { data: rounds = [] } = useQuery({
    queryKey: ['pipeline-collect-history'],
    queryFn: () => pipelineApi.collectHistory(limit),
    refetchInterval: 15_000,
  })

  if (rounds.length === 0) {
    return (
      <div className="p-3">
        <p className="text-xs text-text-disabled">{t('console.act.noCollectHistory')}</p>
      </div>
    )
  }

  function summaryOf(job: PipelineJob) {
    const runs = (job.summary.sources as CollectSourceRun[] | undefined) ?? []
    const ok = runs.filter((r) => r.error == null && !r.empty).length
    const err = runs.filter((r) => r.error).length
    return { runs, ok, err, collected: job.summary.collected ?? 0, inserted: job.summary.inserted ?? 0 }
  }

  return (
    <ul className="max-h-56 space-y-0.5 overflow-y-auto p-2 text-xs">
      {rounds.map((job) => {
        const s = summaryOf(job)
        const failed = job.status === 'failed'
        return (
          <li
            key={job.id}
            className="flex items-center gap-2 rounded-sm px-1.5 py-1 odd:bg-surface-2/30"
            title={s.err > 0 ? (s.runs.find((r) => r.error)?.error ?? '') : undefined}
          >
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${failed ? 'bg-red-400' : s.err > 0 ? 'bg-amber-400' : 'bg-emerald-400'}`} />
            <span className="shrink-0 font-mono text-[10px] text-text-disabled">
              {job.started_at?.slice(11, 19) ?? '—'}
            </span>
            <span className="min-w-0 flex-1 truncate text-text-secondary">
              {s.err > 0
                ? t('console.act.collectErr', { err: s.err, ok: s.ok })
                : t('console.act.collectOk', { n: s.collected, ins: s.inserted, ok: s.ok })}
            </span>
            {s.err > 0 && <Icon name="alert" size={11} className="shrink-0 text-amber-400" />}
          </li>
        )
      })}
    </ul>
  )
}
