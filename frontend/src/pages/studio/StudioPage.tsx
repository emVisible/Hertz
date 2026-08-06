import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import {
  plansApi,
  studioApi,
  type PhaseOrderItem,
  type StudioEvent,
  type WorkflowRun,
} from '../../api'
import { Badge, Button, Card, Icon, Select, useToast } from '../../components/ui'
import { useEventSource } from '../../hooks/useEventSource'

const RUN_TONE: Record<string, 'neutral' | 'success' | 'error' | 'warning' | 'primary'> = {
  running: 'primary',
  completed: 'success',
  failed: 'error',
  cancelled: 'warning',
}

const PHASE_TONE: Record<string, 'neutral' | 'success' | 'error' | 'primary'> = {
  pending: 'neutral',
  running: 'primary',
  completed: 'success',
  failed: 'error',
}

export interface StudioLog {
  id: number
  text: string
  kind: 'phase' | 'agent' | 'system' | 'done'
}

export function StudioPage() {
  const { t } = useTranslation()
  const toast = useToast()
  const queryClient = useQueryClient()

  const { data: plans = [] } = useQuery({ queryKey: ['plans'], queryFn: plansApi.list })
  const { data: runs = [] } = useQuery({ queryKey: ['studio-runs'], queryFn: () => studioApi.runs(20) })

  const [planId, setPlanId] = useState('')
  const [topic, setTopic] = useState('')
  const [running, setRunning] = useState(false)
  const [logs, setLogs] = useState<StudioLog[]>([])
  const [phaseStates, setPhaseStates] = useState<Record<string, string>>({})
  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  const [activeFile, setActiveFile] = useState<string>('final.md')
  const [fileContent, setFileContent] = useState<string>('')

  const logSeq = useRef(0)
  const logEndRef = useRef<HTMLDivElement>(null)
  const activeRunIdRef = useRef<string | null>(null)

  const { data: plan } = useQuery({
    queryKey: ['plan', planId],
    queryFn: () => plansApi.list().then((ps) => ps.find((p) => p.id === planId) ?? null),
    enabled: !!planId,
  })

  const selectedRun = runs.find((r) => r.id === activeRunId) ?? runs[0] ?? null

  useEventSource(studioApi.eventsUrl(), (ev) => {
    const event = JSON.parse(ev.data) as StudioEvent
    if (!activeRunIdRef.current) return
    if (event.run_id && event.run_id !== activeRunIdRef.current) return
    handleEvent(event)
  })

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs])

  useEffect(() => {
    if (!selectedRun) return
    void refreshFile(selectedRun.id, activeFile)
  }, [selectedRun?.id, activeFile])

  function handleEvent(event: StudioEvent) {
    if (event.type === 'phase_start') {
      setPhaseStates((prev) => ({ ...prev, [event.phase!]: 'running' }))
      appendLog({ id: logSeq.current++, text: `[${event.index}/${event.total}] ${phaseName(event.phase!)} ▶ ${t('studio.phaseStatus.running')}`, kind: 'phase' })
    } else if (event.type === 'phase_done') {
      setPhaseStates((prev) => ({ ...prev, [event.phase!]: event.status! }))
      const mark = event.status === 'completed' ? '✓' : '✗'
      const ms = event.duration_ms ? ` (${event.duration_ms}ms)` : ''
      appendLog({ id: logSeq.current++, text: `[${phaseName(event.phase!)}] ${mark} ${statusText(event.status!)}${ms}${event.error ? `: ${event.error}` : ''}`, kind: event.status === 'completed' ? 'phase' : 'done' })
    } else if (event.type === 'log') {
      appendLog({ id: logSeq.current++, text: event.message ?? '', kind: 'agent' })
    } else if (event.type === 'run_done') {
      setRunning(false)
      appendLog({ id: logSeq.current++, text: `── ${t('studio.title')} ${statusText(event.status!)}${event.error ? `: ${event.error}` : ''} ──`, kind: 'done' })
      void queryClient.invalidateQueries({ queryKey: ['studio-runs'] })
      toast(statusText(event.status!), event.status === 'completed' ? 'success' : 'error')
    }
  }

  function appendLog(log: StudioLog) {
    setLogs((prev) => [...prev.slice(-499), log])
  }

  function statusText(status: string): string {
    return t(`studio.runStatus.${status}`) ?? status
  }

  function phaseName(key: string): string {
    return t(`studio.phaseNames.${key}`)
  }

  async function run() {
    if (!planId || !topic.trim()) return
    try {
      setLogs([])
      setPhaseStates({})
      const resp = await plansApi.run(planId, topic.trim())
      activeRunIdRef.current = resp.id
      setActiveRunId(resp.id)
      setRunning(true)
      await queryClient.invalidateQueries({ queryKey: ['studio-runs'] })
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  async function stop() {
    if (!activeRunId) return
    try {
      await studioApi.cancel(activeRunId)
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  async function refreshFile(runId: string, file: string) {
    try {
      const content = await studioApi.readFile(runId, file)
      setFileContent(content)
    } catch {
      setFileContent(t('studio.noLogs'))
    }
  }

  // 文件列表来自运行产物目录（后端权威），不再硬编码（审计发现）。
  const { data: runFiles = [] } = useQuery({
    queryKey: ['studio-files', selectedRun?.id],
    queryFn: () => (selectedRun ? studioApi.files(selectedRun.id).then((r) => r.files) : Promise.resolve([])),
    enabled: !!selectedRun,
  })

  async function selectRun(runId: string) {
    setActiveRunId(runId)
    setActiveFile('final.md')
    void refreshFile(runId, 'final.md')
  }

  const planPhases: PhaseOrderItem[] = plan?.phase_order ?? []
  const runPlan = selectedRun?.plan_id ? plans.find((p) => p.id === selectedRun.plan_id) ?? null : null
  const runPhases: PhaseOrderItem[] = runPlan?.phase_order ?? []
  const files = selectedRun
    ? runFiles.length > 0
      ? runFiles
      : [
          'final.md',
          'summary.md',
          'brief.md',
          ...runPhases
            .map((p) => p.key)
            .filter((k) => k !== 'preflight' && k !== 'image_gen' && k !== 'quality_gate')
            .map((k) => `${k}.md`),
        ]
    : []

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto p-4">
      <Card className="shrink-0">
        <div className="flex flex-wrap items-end gap-3">
          <Select
            label={t('studio.plan')}
            value={planId}
            onChange={(e) => setPlanId(e.target.value)}
            options={plans.map((p) => ({ value: p.id, label: p.name }))}
            className="w-64"
          />
          <textarea
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void run()
            }}
            placeholder={t('studio.topicPlaceholder')}
            rows={2}
            className="min-w-64 flex-1 resize-none rounded-md border border-border bg-surface-1 px-3 py-2 text-sm text-text-primary outline-none placeholder:text-text-disabled focus:border-primary"
          />
          {running ? (
            <Button variant="danger" onClick={stop}>
              <Icon name="stop" size={14} />
              {t('studio.stop')}
            </Button>
          ) : (
            <Button onClick={run} disabled={!planId || !topic.trim()}>
              <Icon name="play" size={14} />
              {t('studio.run')}
            </Button>
          )}
        </div>
      </Card>

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-3">
        <Card padded={false} className="flex min-h-0 flex-col lg:col-span-2">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <h2 className="text-sm font-semibold">
              {t('studio.logs')}
              {running && (
                <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary">
                  {t('studio.running')}
                </span>
              )}
            </h2>
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
                      : log.kind === 'agent'
                        ? 'text-text-secondary'
                        : 'text-text-primary'
                  }
                >
                  {log.text}
                </p>
              ))
            )}
            <div ref={logEndRef} />
          </div>
        </Card>

        <Card padded={false} className="flex min-h-0 flex-col">
          <div className="border-b border-border px-3 py-2">
            <h2 className="text-sm font-semibold">{t('studio.phases')}</h2>
          </div>
          <ul className="min-h-0 flex-1 space-y-1 overflow-auto p-3">
            {planPhases.length === 0 && <p className="text-xs text-text-disabled">{t('studio.noLogs')}</p>}
            {planPhases.map((item) => {
              const state = phaseStates[item.key] ?? 'pending'
              return (
                <li key={item.key} className={`flex items-center gap-2 text-sm ${item.enabled ? '' : 'opacity-40'}`}>
                  <Badge tone={PHASE_TONE[state]}>{t(`studio.phaseStatus.${state}`)}</Badge>
                  <span className={state === 'running' ? 'text-primary' : ''}>{phaseName(item.key)}</span>
                </li>
              )
            })}
          </ul>
          <div className="border-t border-border px-3 py-2">
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-text-secondary">
              {t('studio.history')}
            </h3>
            <ul className="max-h-40 space-y-1 overflow-auto">
              {runs.length === 0 && <p className="text-xs text-text-disabled">{t('studio.noRuns')}</p>}
              {runs.map((run: WorkflowRun) => (
                <li key={run.id}>
                  <button
                    type="button"
                    onClick={() => void selectRun(run.id)}
                    className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs transition-colors ${
                      selectedRun?.id === run.id ? 'bg-surface-2' : 'hover:bg-surface-2/50'
                    }`}
                  >
                    <Badge tone={RUN_TONE[run.status]}>{t(`studio.runStatus.${run.status}`)}</Badge>
                    <span className="truncate text-text-secondary">
                      {(run.context.topic as string) ?? run.id.slice(0, 8)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </Card>
      </div>

      {selectedRun && (
        <Card padded={false} className="flex min-h-0 flex-col">
          <div className="flex items-center gap-2 overflow-x-auto border-b border-border px-3 py-2">
            <Icon name="file" size={14} />
            {files.map((file) => (
              <button
                key={file}
                type="button"
                onClick={() => {
                  setActiveFile(file)
                  void refreshFile(selectedRun.id, file)
                }}
                className={`shrink-0 rounded-md px-2 py-1 text-xs transition-colors ${
                  activeFile === file ? 'bg-surface-2 text-text-primary' : 'text-text-secondary hover:bg-surface-2/50'
                }`}
              >
                {file}
              </button>
            ))}
          </div>
          <pre className="max-h-96 min-h-40 overflow-auto whitespace-pre-wrap p-3 font-mono text-xs leading-relaxed text-text-primary">
            {fileContent || t('studio.noLogs')}
          </pre>
        </Card>
      )}
    </div>
  )
}
