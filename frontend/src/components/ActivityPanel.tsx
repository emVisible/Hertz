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
 * 全局活动横条（v0.3.5，浏览器下载栏语义）：AppShell 底部常驻——
 * 所有页面可见，展开显示 实时事件 / 最近任务 / 系统日志 三 tab。
 * 收起时仅一条窄栏（运行中高亮脉冲）。
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
          {logs.length > 0 && !open && <span className="ml-2 text-text-disabled">· {logs.length} 事件</span>}
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
          <div className="h-48 overflow-y-auto p-2">
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
    </div>
  )
}
