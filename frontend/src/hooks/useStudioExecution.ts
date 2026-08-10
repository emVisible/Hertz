import { useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { buffsApi, plansApi, studioApi, type PhaseOrderItem, type StudioEvent, type WorkflowRun } from '../api'
import { phaseLabel } from '../i18n'
import { useEventSource } from './useEventSource'
import { useToast } from '../components/ui'
import { useExecutionStore } from '../stores/execution'
import type { LogLine } from '../components/execution'

export interface StudioLog extends LogLine {
  kind: 'phase' | 'agent' | 'system' | 'done'
}

/** Studio 域执行状态（从 StudioPage 抽取，逻辑零改动）。 */
export function useStudioExecution() {
  const { t } = useTranslation()
  const toast = useToast()
  const queryClient = useQueryClient()

  const { data: plans = [] } = useQuery({ queryKey: ['plans'], queryFn: plansApi.list })
  const { data: runs = [] } = useQuery({ queryKey: ['studio-runs'], queryFn: () => studioApi.runs(20) })

  const store = useExecutionStore()
  const { planId, topic, running, logs, phaseStates, activeRunId, activeFile, fileContent, buffKeys, depth } = store.studio
  const setStudio = store.setStudio

  // ref 与 store 同步：切 tab/重挂载后 ref 恢复，SSE 事件不被丢弃
  const activeRunIdRef = useRef<string | null>(null)
  useEffect(() => {
    activeRunIdRef.current = activeRunId
  }, [activeRunId])

  const setPlanId = (v: string) => setStudio({ planId: v })
  const setTopic = (v: string) => setStudio({ topic: v })
  const setRunning = (v: boolean) => setStudio({ running: v })
  const setActiveRunId = (v: string | null) => setStudio({ activeRunId: v })
  const setActiveFile = (v: string) => setStudio({ activeFile: v })
  const setBuffKeys = (v: string[]) => setStudio({ buffKeys: v })
  const setDepth = (v: string) => setStudio({ depth: v })

  // buff 列表（运行时选择器）
  const { data: buffs = [] } = useQuery({ queryKey: ['buffs'], queryFn: buffsApi.list })

  // 默认选中第一个计划（AXIOM §2.5 体验）：进来不该让用户手动选；
  // 仅当未选/所选已不存在时才回退到首个，用户主动选过的保持不变
  useEffect(() => {
    if (plans.length === 0) return
    if (!planId || !plans.some((p) => p.id === planId)) {
      setStudio({ planId: plans[0].id })
    }
  }, [plans, planId, setStudio])

  const { data: plan } = useQuery({
    queryKey: ['plan', planId],
    queryFn: () => plansApi.list().then((ps) => ps.find((p) => p.id === planId) ?? null),
    enabled: !!planId,
  })

  // 画布 → Studio：读取草稿主题并自动开跑（画布是流水线输入端）
  useEffect(() => {
    const draft = localStorage.getItem('hertz-studio-draft')
    if (!draft) return
    localStorage.removeItem('hertz-studio-draft')
    setTopic(draft)
    const pid = planId
    if (pid) {
      const timer = setTimeout(() => {
        void runWith(draft, pid)
      }, 300)
      return () => clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const selectedRun = runs.find((r) => r.id === activeRunId) ?? runs[0] ?? null

  useEventSource(studioApi.eventsUrl(), (ev) => {
    const event = JSON.parse((ev as { data: string }).data) as StudioEvent
    // ref 为空（重挂载/切 tab 后）时不丢弃——接受事件跟随后端最新 run；
    // 有明确 run_id 时才过滤，避免旧 run 事件污染当前状态
    const target = activeRunIdRef.current
    if (event.run_id && target && event.run_id !== target) return
    handleEvent(event)
  })

  useEffect(() => {
    if (!selectedRun) return
    void refreshFile(selectedRun.id, activeFile)
  }, [selectedRun?.id, activeFile]) // eslint-disable-line react-hooks/exhaustive-deps

  function handleEvent(event: StudioEvent) {
    if (event.type === 'phase_start') {
      setStudio({ phaseStates: { ...useExecutionStore.getState().studio.phaseStates, [event.phase!]: 'running' } })
      appendLog(`[${event.index}/${event.total}] ${phaseName(event.phase!)} ▶ ${t('studio.phaseStatus.running')}`, 'phase')
    } else if (event.type === 'phase_done') {
      setStudio({ phaseStates: { ...useExecutionStore.getState().studio.phaseStates, [event.phase!]: event.status! } })
      const mark = event.status === 'completed' ? '✓' : '✗'
      const ms = event.duration_ms ? ` (${event.duration_ms}ms)` : ''
      appendLog(
        `[${phaseName(event.phase!)}] ${mark} ${statusText(event.status!)}${ms}${event.error ? `: ${event.error}` : ''}`,
        event.status === 'completed' ? 'phase' : 'done',
      )
      // 阶段完成后刷新产物清单（新文件已落盘）
      void queryClient.invalidateQueries({ queryKey: ['studio-files'] })
      void queryClient.invalidateQueries({ queryKey: ['studio-run-detail'] })
    } else if (event.type === 'log') {
      appendLog(event.message ?? '', 'agent')
    } else if (event.type === 'run_done') {
      setRunning(false)
      appendLog(`── ${t('studio.title')} ${statusText(event.status!)}${event.error ? `: ${event.error}` : ''} ──`, 'done')
      void queryClient.invalidateQueries({ queryKey: ['studio-runs'] })
      void queryClient.invalidateQueries({ queryKey: ['studio-files'] })
      void queryClient.invalidateQueries({ queryKey: ['studio-run-detail'] })
      toast(statusText(event.status!), event.status === 'completed' ? 'success' : 'error')
    }
  }

  function appendLog(text: string, kind: StudioLog['kind']) {
    const now = new Date()
    const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`
    setStudio({ logs: [...useExecutionStore.getState().studio.logs.slice(-499), { id: useExecutionStore.getState().studio.logSeq, time, text, kind }], logSeq: useExecutionStore.getState().studio.logSeq + 1 })
  }

  function statusText(status: string): string {
    return t(`studio.runStatus.${status}`) ?? status
  }

  function phaseName(key: string): string {
    return phaseLabel(t, key)
  }

  async function run() {
    await runWith(topic.trim(), planId)
  }

  async function runWith(topicText: string, pid: string) {
    if (!pid || !topicText) return
    try {
      store.resetStudioLogs()
      // 运行时 buff：非空则覆盖计划配置；空数组让后端用计划持久配置
      const runBuffs = buffKeys.length > 0 ? buffKeys : undefined
      const resp = await plansApi.run(pid, topicText, runBuffs, depth)
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

  async function refreshFile(runId: string, file: string): Promise<string> {
    try {
      const content = await studioApi.readFile(runId, file)
      setStudio({ fileContent: content })
      return content
    } catch {
      setStudio({ fileContent: t('studio.noLogs') })
      return t('studio.noLogs')
    }
  }

  const { data: runFiles = [] } = useQuery({
    queryKey: ['studio-files', selectedRun?.id],
    queryFn: () => (selectedRun ? studioApi.files(selectedRun.id).then((r) => r.files) : Promise.resolve([])),
    enabled: !!selectedRun,
  })

  // 运行详情（含每阶段 status/duration/error）——阶段详情弹窗数据源
  const { data: runDetail } = useQuery({
    queryKey: ['studio-run-detail', selectedRun?.id],
    queryFn: () => (selectedRun ? studioApi.get(selectedRun.id) : Promise.resolve(null)),
    enabled: !!selectedRun,
    refetchInterval: (query) => {
      const run = query.state.data
      return run?.status === 'running' ? 2000 : false
    },
  })

  // 阶段状态权威同步：SSE 事件丢失/重连时，用 runDetail（2s 轮询）兜底追上。
  // 产物文件都出来了但阶段状态卡住，就是 SSE 事件没到——这里保证状态最终一致。
  useEffect(() => {
    if (!runDetail?.phases || runDetail.phases.length === 0) return
    setStudio({
      phaseStates: {
        ...useExecutionStore.getState().studio.phaseStates,
        ...Object.fromEntries(
          runDetail.phases
            .filter((ph) => ph.status && ph.status !== 'pending')
            .map((ph) => [ph.key, ph.status]),
        ),
      },
    })
    // run 终态：残留的 running 阶段清掉（跑完/失败后不该再有"进行中"）
    if (runDetail.status && runDetail.status !== 'running') {
      const current = useExecutionStore.getState().studio.phaseStates
      const stale = Object.keys(current).filter((k) => current[k] === 'running')
      if (stale.length > 0) {
        setStudio({
          phaseStates: {
            ...current,
            ...Object.fromEntries(stale.map((k) => [k, 'pending'])),
          },
        })
      }
    }
  }, [runDetail, setStudio])

  async function selectRun(runId: string) {
    setActiveRunId(runId)
    setActiveFile('final.md')
    void refreshFile(runId, 'final.md')
  }

  const planPhases: PhaseOrderItem[] = plan?.phase_order ?? []
  // 产物文件只来自后端权威清单（不再硬编码 fallback——猜测的文件名永远点不开）
  const files = selectedRun ? runFiles : []

  const runningPhase = planPhases.find((item) => phaseStates[item.key] === 'running')
  const currentPlan = plans.find((p) => p.id === planId) ?? null
  const runCount = planPhases.filter((item) => item.enabled).length

  return {
    plans,
    runs,
    planId,
    setPlanId,
    topic,
    setTopic,
    running,
    logs,
    clearLogs: () => store.resetStudioLogs(),
    phaseStates,
    activeRunId,
    activeFile,
    setActiveFile,
    fileContent,
    selectedRun,
    runDetail,
    run: () => void run(),
    stop,
    selectRun,
    refreshFile,
    planPhases,
    files,
    runningPhase,
    currentPlan,
    runCount,
    statusText,
    phaseName,
    buffs,
    buffKeys,
    setBuffKeys,
    depth,
    setDepth,
  }
}

export type { WorkflowRun }
