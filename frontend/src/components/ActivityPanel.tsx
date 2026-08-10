import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { api } from '../api'
import { pipelineApi } from '../api/pipeline'
import { Icon } from './ui'
import { useExecutionStore } from '../stores/execution'
import type { LogLine } from './execution'

type ActivityTab = 'events' | 'jobs' | 'system'

/**
 * 全局活动浮窗（v0.3.4，浏览器下载栏语义）：右下角常驻按钮，
 * 所有页面可见——实时事件 / 最近任务 / 系统日志 三 tab。
 * 数据：事件走 execution store（AppShell 常驻共享）；任务/系统日志轮询。
 */
export function ActivityPanel() {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<ActivityTab>('events')
  const logs = useExecutionStore((s) => s.pipeline.logs)
  const panelRef = useRef<HTMLDivElement>(null)

  const { data: jobs = [] } = useQuery({
    queryKey: ['pipeline-jobs'],
    queryFn: () => pipelineApi.jobs(8),
    refetchInterval: open ? 5000 : false,
  })
  const { data: sysLines = [] } = useQuery({
    queryKey: ['sys-logs-panel'],
    queryFn: () => api.get<{ lines: string[] }>('/api/logs/buffer?limit=120').then((r) => r.lines),
    refetchInterval: open ? 5000 : false,
  })

  // Esc 关闭
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  // 点击外部关闭
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  const tabs: Array<{ id: ActivityTab; label: string }> = [
    { id: 'events', label: t('console.act.events') },
    { id: 'jobs', label: t('console.jobs') },
    { id: 'system', label: t('console.sysLogs') },
  ]

  return (
    <div ref={panelRef} className="fixed bottom-4 right-4 z-40">
      {open && (
        <div className="hz-fade-in mb-2 w-96 overflow-hidden rounded-lg border border-border bg-surface-1 shadow-lg">
          <div className="flex items-center gap-1 border-b border-border px-2 pt-1.5">
            {tabs.map((tb) => (
              <button
                key={tb.id}
                type="button"
                onClick={() => setTab(tb.id)}
                className={`flex-1 border-b-2 px-2 py-1.5 text-xs font-medium transition-colors ${
                  tab === tb.id
                    ? 'border-primary text-text-primary'
                    : 'border-transparent text-text-secondary hover:text-text-primary'
                }`}
              >
                {tb.label}
              </button>
            ))}
          </div>

          <div className="h-64 overflow-y-auto p-2">
            {tab === 'events' && (
              <div className="flex flex-col gap-1 font-mono text-[10px] leading-relaxed">
                {logs.length === 0 && <p className="p-2 text-text-disabled">{t('console.noLogs')}</p>}
                {logs.map((log: LogLine) => (
                  <div key={log.id} className="flex gap-1.5 px-1">
                    <span className="shrink-0 select-none text-text-disabled">{log.time}</span>
                    <span className="min-w-0 break-all text-text-secondary">{log.text}</span>
                  </div>
                ))}
              </div>
            )}
            {tab === 'jobs' && (
              <ul className="space-y-1">
                {jobs.length === 0 && <p className="p-2 text-xs text-text-disabled">{t('console.noJobs')}</p>}
                {jobs.map((job) => (
                  <li key={job.id} className="flex items-center gap-2 px-1.5 py-1 text-xs">
                    <span
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                        job.status === 'completed' ? 'bg-success' : job.status === 'failed' ? 'bg-error' : 'bg-warning'
                      }`}
                    />
                    <span className="min-w-0 flex-1 truncate text-text-primary">{job.job}</span>
                    <span className="shrink-0 font-mono text-[10px] text-text-disabled">{job.status}</span>
                  </li>
                ))}
              </ul>
            )}
            {tab === 'system' && (
              <pre className="whitespace-pre-wrap break-all font-mono text-[10px] leading-relaxed text-text-secondary">
                {sysLines.length === 0 ? t('console.sysLogsEmpty') : sysLines.join('\n')}
              </pre>
            )}
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={t('console.act.title')}
        aria-label={t('console.act.title')}
        className="flex h-11 w-11 items-center justify-center rounded-full border border-border bg-surface-1 shadow-md transition-colors hover:border-primary hover:text-primary"
      >
        <Icon name="console" size={18} className="text-text-secondary" />
        {logs.length > 0 && (
          <span className="absolute right-0 top-0 h-2.5 w-2.5 animate-pulse rounded-full bg-primary" />
        )}
      </button>
    </div>
  )
}
