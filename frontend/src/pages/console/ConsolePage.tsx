import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import {
  pipelineApi,
  type PipelineEvent,
  type PipelineItem,
  type PipelineJob,
} from '../../api'
import { Badge, Button, Card, Icon, Select, useToast } from '../../components/ui'
import { useEventSource } from '../../hooks/useEventSource'

const ITEM_TONE: Record<string, 'neutral' | 'success' | 'error' | 'warning' | 'primary'> = {
  discovered: 'neutral',
  scored: 'primary',
  downloaded: 'primary',
  queued: 'warning',
  approved: 'primary',
  published: 'success',
  rejected: 'error',
  failed: 'error',
}

const JOB_TONE: Record<string, 'neutral' | 'success' | 'error'> = {
  completed: 'success',
  failed: 'error',
  running: 'neutral',
}

export interface ConsoleLog {
  id: number
  text: string
  kind: 'job' | 'item' | 'done' | 'system'
}

export function ConsolePage() {
  const { t } = useTranslation()
  const toast = useToast()
  const queryClient = useQueryClient()

  const { data: status } = useQuery({
    queryKey: ['pipeline-status'],
    queryFn: pipelineApi.status,
    refetchInterval: 2000,
  })
  const { data: steps = [] } = useQuery({
    queryKey: ['pipeline-steps'],
    queryFn: () => pipelineApi.steps().then((s) => s.steps),
  })
  const { data: counts = {} } = useQuery({
    queryKey: ['pipeline-counts'],
    queryFn: pipelineApi.counts,
    refetchInterval: 2000,
  })
  const { data: items = [] } = useQuery({
    queryKey: ['pipeline-items'],
    queryFn: () => pipelineApi.items(undefined, 50),
    refetchInterval: 2000,
  })
  const { data: jobs = [] } = useQuery({
    queryKey: ['pipeline-jobs'],
    queryFn: () => pipelineApi.jobs(8),
    refetchInterval: 2000,
  })
  const { data: sources = [] } = useQuery({
    queryKey: ['pipeline-sources'],
    queryFn: pipelineApi.sources,
  })

  const [step, setStep] = useState('chain')
  const [limit, setLimit] = useState(10)
  const [logs, setLogs] = useState<ConsoleLog[]>([])

  const logSeq = useRef(0)
  const logEndRef = useRef<HTMLDivElement>(null)
  const runningRef = useRef(false)

  useEventSource(pipelineApi.eventsUrl(), (ev) => {
    const event = JSON.parse(ev.data) as PipelineEvent
    handleEvent(event)
  })

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs])

  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: ['pipeline-items'] })
    void queryClient.invalidateQueries({ queryKey: ['pipeline-counts'] })
  }, [status?.running, queryClient])

  function appendLog(log: ConsoleLog) {
    setLogs((prev) => [...prev.slice(-199), log])
  }

  function handleEvent(event: PipelineEvent) {
    if (event.type === 'job_step') {
      const text = `[${event.step}] ${event.step === 'collect' ? `${t('console.collected', { n: event.count ?? 0 })}` : `${t('console.processed', { n: event.count ?? 0 })}`}`
      appendLog({ id: logSeq.current++, text, kind: 'job' })
    } else if (event.type === 'item') {
      appendLog({
        id: logSeq.current++,
        text: `${t('console.item')} ${event.status}${event.error ? `: ${event.error}` : ''}`,
        kind: event.status === 'rejected' || event.status === 'failed' ? 'done' : 'item',
      })
    } else if (event.type === 'job_done') {
      const failed = event.status === 'failed'
      appendLog({
        id: logSeq.current++,
        text: `── [${event.job}] ${failed ? '✗' : '✓'}${event.error ? `: ${event.error}` : ''} ──`,
        kind: 'done',
      })
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

  const running = status?.running ?? false

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto p-4">
      <Card className="shrink-0">
        <div className="flex flex-wrap items-end gap-3">
          <Select
            label={t('console.step')}
            value={step}
            onChange={(e) => setStep(e.target.value)}
            options={[
              { value: 'chain', label: t('console.chain') },
              ...steps.map((s) => ({ value: s, label: s })),
            ]}
            className="w-44"
          />
          <Select
            label={t('console.limit')}
            value={String(limit)}
            onChange={(e) => setLimit(Number(e.target.value))}
            options={[5, 10, 25, 50].map((n) => ({ value: String(n), label: String(n) }))}
            className="w-28"
          />
          {running ? (
            <Button variant="danger" onClick={stop}>
              <Icon name="stop" size={14} />
              {t('console.stop')}
            </Button>
          ) : (
            <Button onClick={run} disabled={!step}>
              <Icon name="play" size={14} />
              {t('console.run')}
            </Button>
          )}
          <Badge tone={running ? 'primary' : 'neutral'}>
            {running ? `${t('console.running')}: ${status?.job ?? ''}` : t('console.idle')}
          </Badge>
        </div>
      </Card>

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-3">
        <Card padded={false} className="flex min-h-0 flex-col lg:col-span-2">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <h2 className="text-sm font-semibold">{t('console.reviewQueue')}</h2>
            <div className="flex gap-2 text-xs text-text-secondary">
              {['discovered', 'scored', 'downloaded', 'queued', 'approved', 'published', 'rejected', 'failed'].map(
                (s) => (
                  <span key={s} className="flex items-center gap-1">
                    <Badge tone={ITEM_TONE[s]}>{s}</Badge>
                    {counts[s] ?? 0}
                  </span>
                ),
              )}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {items.length === 0 ? (
              <p className="p-4 text-sm text-text-disabled">{t('console.noItems')}</p>
            ) : (
              <table className="w-full text-left text-sm">
                <thead className="sticky top-0 bg-surface-1 text-xs text-text-secondary">
                  <tr>
                    <th className="px-3 py-2 font-medium">{t('console.title')}</th>
                    <th className="px-3 py-2 font-medium">{t('console.source')}</th>
                    <th className="px-3 py-2 font-medium">{t('console.score')}</th>
                    <th className="px-3 py-2 font-medium">{t('console.status')}</th>
                    <th className="px-3 py-2 font-medium">{t('console.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.id} className="border-t border-border/60 align-top">
                      <td className="max-w-64 px-3 py-2">
                        <p className="truncate" title={item.title}>
                          {item.title}
                        </p>
                        {item.error && (
                          <p className="mt-0.5 truncate text-xs text-error" title={item.error}>
                            {item.error}
                          </p>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs text-text-secondary">
                        {item.subreddit} / u/{item.author}
                        <p className="text-text-disabled">r{item.reddit_score}</p>
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {item.score_total != null ? item.score_total.toFixed(1) : '—'}
                      </td>
                      <td className="px-3 py-2">
                        <Badge tone={ITEM_TONE[item.status]}>{item.status}</Badge>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex gap-1.5">
                          {item.status === 'queued' && (
                            <Button size="sm" onClick={() => void act(item, 'approve')}>
                              <Icon name="check" size={12} />
                              {t('console.approve')}
                            </Button>
                          )}
                          {(item.status === 'queued' ||
                            item.status === 'scored' ||
                            item.status === 'downloaded') && (
                            <Button size="sm" variant="danger" onClick={() => void act(item, 'reject')}>
                              <Icon name="close" size={12} />
                              {t('console.reject')}
                            </Button>
                          )}
                          {item.status === 'failed' && (
                            <Button size="sm" variant="ghost" onClick={() => void act(item, 'retry')}>
                              {t('common.retry')}
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Card>

        <div className="flex min-h-0 flex-col gap-4">
          <Card padded={false} className="flex min-h-0 flex-col">
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <h2 className="text-sm font-semibold">{t('console.logs')}</h2>
              <Button size="sm" variant="ghost" onClick={refresh}>
                <Icon name="check" size={12} />
                {t('common.refresh')}
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-3 font-mono text-xs leading-relaxed">
              {logs.length === 0 ? (
                <p className="text-text-disabled">{t('studio.noLogs')}</p>
              ) : (
                logs.map((log) => (
                  <p
                    key={log.id}
                    className={
                      log.kind === 'done'
                        ? 'mt-1 font-semibold text-error'
                        : log.kind === 'item'
                          ? 'text-text-primary'
                          : 'text-text-secondary'
                    }
                  >
                    {log.text}
                  </p>
                ))
              )}
              <div ref={logEndRef} />
            </div>
          </Card>

          <Card padded={false} className="shrink-0">
            <div className="border-b border-border px-3 py-2">
              <h2 className="text-sm font-semibold">{t('console.jobs')}</h2>
            </div>
            <ul className="max-h-44 space-y-1 overflow-auto p-3">
              {jobs.length === 0 && <p className="text-xs text-text-disabled">{t('console.noJobs')}</p>}
              {jobs.map((job: PipelineJob) => (
                <li key={job.id} className="flex items-center gap-2 text-xs">
                  <Badge tone={JOB_TONE[job.status]}>{job.status}</Badge>
                  <span>{job.job}</span>
                  {job.error && <span className="truncate text-error" title={job.error}>{job.error}</span>}
                </li>
              ))}
            </ul>
          </Card>

          <Card padded={false} className="shrink-0">
            <div className="border-b border-border px-3 py-2">
              <h2 className="text-sm font-semibold">{t('console.sources')}</h2>
            </div>
            <ul className="space-y-1 p-3 text-xs">
              {sources.length === 0 && <p className="text-text-disabled">{t('console.noSources')}</p>}
              {sources.map((s) => (
                <li key={`${s.source}:${s.channel}`} className="flex items-center justify-between gap-2">
                  <span>
                    {s.source}:{s.channel}
                  </span>
                  <span className="text-text-secondary">
                    ok {s.ok_count} / fail {s.fail_count}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  )
}
