import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'

import {
  Badge,
  CopyButton,
  Icon,
  Select,
} from '../../components/ui'
import {
  CommandDeck,
  ProgressStrip,
  StatusSteps,
  Terminal,
} from '../../components/execution'
import { useStudioExecution } from '../../hooks/useStudioExecution'
import { useModelSwitch } from '../../hooks/useModelSwitch'
import { studioApi, type WorkflowRun } from '../../api/orchestration'
import { Modal, useToast } from '../../components/ui'

const STUDIO_PHASE_DOT: Record<string, string> = {
  pending: 'bg-text-disabled/40',
  running: 'animate-pulse bg-primary',
  completed: 'bg-success',
  failed: 'bg-error',
}

const RUN_TONE: Record<string, 'neutral' | 'success' | 'error' | 'warning' | 'primary'> = {
  running: 'primary',
  completed: 'success',
  failed: 'error',
  cancelled: 'warning',
}

/** 输出深度五档 fallback（v0.3.10）：深度库查询失败时的内置档位 */
const DEPTHS: Array<{ id: string }> = [
  { id: 'terse' },
  { id: 'concise' },
  { id: 'normal' },
  { id: 'detailed' },
  { id: 'deep' },
]

// ================= Studio 域 =================

interface StudioViewProps {
  plans: ReturnType<typeof useStudioExecution>['plans']
  planId: string
  setPlanId: (v: string) => void
  topic: string
  setTopic: (v: string) => void
  running: boolean
  logs: ReturnType<typeof useStudioExecution>['logs']
  phaseStates: Record<string, string>
  runs: ReturnType<typeof useStudioExecution>['runs']
  runningPhase: ReturnType<typeof useStudioExecution>['runningPhase']
  planPhases: ReturnType<typeof useStudioExecution>['planPhases']
  selectedRun: ReturnType<typeof useStudioExecution>['selectedRun']
  activeFile: string
  setActiveFile: (v: string) => void
  fileContent: string
  statusText: (s: string) => string
  phaseName: (k: string) => string
  run: () => void
  stop: () => void
  selectRun: (id: string) => void
  refreshFile: (runId: string, file: string) => Promise<string>
  modelSwitch: ReturnType<typeof useModelSwitch>
  runDetail: ReturnType<typeof useStudioExecution>['runDetail']
  buffs: ReturnType<typeof useStudioExecution>['buffs']
  buffKeys: string[]
  setBuffKeys: (v: string[]) => void
  depth: string
  setDepth: (v: string) => void
  depthLevels: ReturnType<typeof useStudioExecution>['depthLevels']
}

export function StudioView(p: StudioViewProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [fileModal, setFileModal] = useState<{ file: string; content: string } | null>(null)
  const [phaseDetail, setPhaseDetail] = useState<string | null>(null)
  // 运行对比（v0.4 D1）：⌘/Shift 选中两个 run → 产物 diff
  const [compareSel, setCompareSel] = useState<string[]>([])
  const [diffPair, setDiffPair] = useState<{ a: WorkflowRun; b: WorkflowRun } | null>(null)
  const toggleCompare = (run: WorkflowRun) => {
    setCompareSel((prev) => {
      if (prev.includes(run.id)) return prev.filter((id) => id !== run.id)
      if (prev.length >= 2) return [prev[1], run.id]
      return [...prev, run.id]
    })
  }
  const runById = (id: string) => p.runs.find((r) => r.id === id)
  return (
    <>
      <CommandDeck
        title={t('studio.title')}
        icon="studio"
        running={p.running}
        onRun={p.run}
        onStop={p.stop}
        runDisabled={!p.planId || !p.topic.trim()}
        controls={
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-3 lg:flex-row">
              <div className="flex w-full shrink-0 gap-3 lg:w-[26rem]">
                <div className="w-1/2 min-w-0">
                  <Select
                    label={t('studio.model')}
                    value={p.modelSwitch.current}
                    onChange={(e) => void p.modelSwitch.switchModel(e.target.value)}
                    options={[
                      { value: '', label: t('studio.modelDefault') },
                      ...p.modelSwitch.chatModels,
                    ]}
                    className="w-full"
                  />
                </div>
                <div className="w-1/2 min-w-0">
                  <Select
                    label={t('studio.plan')}
                    value={p.planId}
                    onChange={(e) => p.setPlanId(e.target.value)}
                    options={[{ value: '', label: t('studio.noPlan') }, ...p.plans.map((pl) => ({ value: pl.id, label: pl.name }))]}
                    className="w-full"
                  />
                </div>
              </div>
              <div className="min-w-0 flex-1">
                <label className="mb-1 block text-xs text-text-secondary">{t('studio.topic')}</label>
                <textarea
                  value={p.topic}
                  onChange={(e) => p.setTopic(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') p.run()
                  }}
                  placeholder={t('studio.topicPlaceholder')}
                  rows={2}
                  className="w-full resize-none border border-border bg-surface-1 px-3 py-2 text-sm text-text-primary outline-none placeholder:text-text-disabled focus:border-primary"
                />
              </div>
            </div>
            {/* Buff / Debuff 多选（v5.2）：Buff 一行、Debuff 一行。
               标签列固定宽度（w-11）保证两行选项区起点对齐（上下不歪）；
               选中项为 pill 底色（与可选项的纯文字形成分度，一眼可区分）。 */}
            {p.buffs.length > 0 && (
              <div className="flex flex-col gap-1 border-t border-border pt-2">
                {/* 第一行：Buff（正向） */}
                <div className="flex items-center gap-2">
                  <span className="w-11 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-text-disabled">
                    {t('studio.buffs')}
                  </span>
                  <div className="scrollbar-none flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto py-0.5">
                    {p.buffs.filter((b) => b.category === 'stable' && b.enabled && b.polarity === 'buff').map((buff) => {
                      const active = p.buffKeys.includes(buff.key)
                      return (
                        <button
                          key={buff.id}
                          type="button"
                          onClick={() => {
                            p.setBuffKeys(
                              active
                                ? p.buffKeys.filter((k) => k !== buff.key)
                                : [...p.buffKeys, buff.key],
                            )
                          }}
                          title={buff.effect}
                          className={`shrink-0 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                            active
                              ? 'border-primary/40 bg-primary/15 font-medium text-primary'
                              : 'border-transparent text-text-disabled hover:border-border hover:text-text-secondary'
                          }`}
                        >
                          {buff.name}
                        </button>
                      )
                    })}
                    {p.buffs.some((b) => b.category === 'random' && b.enabled) && (
                      <button
                        type="button"
                        onClick={() => {
                          const active = p.buffKeys.includes('random')
                          p.setBuffKeys(
                            active ? p.buffKeys.filter((k) => k !== 'random') : [...p.buffKeys, 'random'],
                          )
                        }}
                        title={t('studio.buffRandomHint')}
                        className={`shrink-0 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                          p.buffKeys.includes('random')
                            ? 'border-warning/50 bg-warning/15 font-medium text-warning'
                            : 'border-transparent text-text-disabled hover:border-border hover:text-text-secondary'
                        }`}
                      >
                        🎲 {t('studio.buffRandom')}
                      </button>
                    )}
                  </div>
                </div>
                {/* 深度档位（v0.3.10）：并列于 buff/debuff 之间，单选——档位来自深度库 */}
                <div className="flex items-center gap-2">
                  <span className="w-11 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-text-disabled">
                    {t('studio.depth')}
                  </span>
                  <div className="scrollbar-none flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto py-0.5">
                    {(p.depthLevels.length > 0
                      ? p.depthLevels.filter((d) => d.enabled)
                      : DEPTHS.map((d) => ({ id: d.id, key: d.id, name: t(`studio.depth.${d.id}.label`), effect: t(`studio.depth.${d.id}.hint`), enabled: true }))
                    ).map((d) => {
                      const active = p.depth === d.key || p.depth === d.id
                      return (
                        <button
                          key={d.id ?? d.key}
                          type="button"
                          onClick={() => p.setDepth(d.key ?? d.id)}
                          title={d.effect || t('studio.depthNormalHint')}
                          className={`shrink-0 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                            active
                              ? 'border-primary/40 bg-primary/15 font-medium text-primary'
                              : 'border-transparent text-text-disabled hover:border-border hover:text-text-secondary'
                          }`}
                        >
                          {d.name}
                        </button>
                      )
                    })}
                  </div>
                </div>
                {/* 第二行：Debuff（反向禁忌，中性色与 Buff 对齐） */}
                {p.buffs.some((b) => b.polarity === 'debuff' && b.enabled) && (
                  <div className="flex items-center gap-2">
                    <span className="w-11 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-text-disabled">
                      {t('studio.debuffs')}
                    </span>
                    <div className="scrollbar-none flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto py-0.5">
                      {p.buffs.filter((b) => b.polarity === 'debuff' && b.enabled).map((buff) => {
                        const active = p.buffKeys.includes(buff.key)
                        return (
                          <button
                            key={buff.id}
                            type="button"
                            onClick={() => {
                              p.setBuffKeys(
                                active
                                  ? p.buffKeys.filter((k) => k !== buff.key)
                                  : [...p.buffKeys, buff.key],
                              )
                            }}
                            title={buff.effect}
                            className={`shrink-0 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                              active
                                ? 'border-primary/40 bg-primary/15 font-medium text-primary'
                                : 'border-transparent text-text-disabled hover:border-border hover:text-text-secondary'
                            }`}
                          >
                            {buff.name}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        }
      />

      {p.running && p.runningPhase && (
        <ProgressStrip
          label={p.phaseName(p.runningPhase.key)}
          index={p.planPhases.findIndex((item) => item.key === p.runningPhase!.key) + 1}
          total={p.planPhases.length}
          value={p.planPhases.filter((item) => p.phaseStates[item.key] === 'completed').length / Math.max(p.planPhases.length, 1) * 100}
        />
      )}

      {/* 阶段状态（横向步骤条）+ 各阶段产物文件（融合在节点下方） */}
      <StatusSteps
        title={t('studio.phases')}
        items={p.planPhases.map((item) => {
          const phase = p.runDetail?.phases?.find((ph) => ph.key === item.key)
          return {
            key: item.key,
            label: p.phaseName(item.key),
            status: p.phaseStates[item.key] ?? 'pending',
            enabled: item.enabled,
            files: phase?.files && phase.files.length > 0 ? phase.files : undefined,
          }
        })}
        dotClass={(status) => STUDIO_PHASE_DOT[status] ?? 'bg-text-disabled/40'}
        statusText={(status) => t(`studio.phaseStatus.${status}`)}
        onSelect={setPhaseDetail}
        onOpenFile={(file) => {
          if (!p.selectedRun) return
          p.setActiveFile(file)
          void p.refreshFile(p.selectedRun.id, file).then((content) => {
            setFileModal({ file, content })
          })
        }}
      />

      {/* 实时日志（占满），运行记录融入终端底部 */}
      <div className="flex min-h-0 flex-1 flex-col">
        <Terminal
          title={t('studio.logs')}
          lines={p.logs}
          streaming={p.running}
          kindClass={(kind) =>
            kind === 'done' ? 'font-semibold text-error' : kind === 'agent' ? 'text-text-secondary' : 'text-text-primary'
          }
          bottom={
            <div className="px-3 py-2">
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-text-disabled">
                {t('studio.history')}
              </p>
              <div className="flex items-center gap-1.5 overflow-x-auto">
                {p.runs.length === 0 && <p className="text-[11px] text-text-disabled">{t('studio.noRuns')}</p>}
                {p.runs.map((run) => {
                  const inCompare = compareSel.includes(run.id)
                  return (
                    <button
                      key={run.id}
                      type="button"
                      onClick={(e) => {
                        if (e.metaKey || e.ctrlKey || e.shiftKey) {
                          toggleCompare(run)
                          return
                        }
                        p.selectRun(run.id)
                      }}
                      title={inCompare ? t('studio.compareSelected') : undefined}
                      className={`flex shrink-0 items-center gap-1.5 border px-2 py-1 text-[11px] transition-colors ${
                        inCompare
                          ? 'border-warning bg-warning/10 text-warning'
                          : p.selectedRun?.id === run.id
                            ? 'border-primary bg-primary/10 text-text-primary'
                            : 'border-border text-text-secondary hover:bg-surface-2'
                      }`}
                    >
                      <Badge tone={RUN_TONE[run.status] ?? 'neutral'}>{t(`studio.runStatus.${run.status}`)}</Badge>
                      <span className="max-w-40 truncate">
                        {(run.context.topic as string) ?? run.id.slice(0, 8)}
                      </span>
                    </button>
                  )
                })}
                {/* 对比入口（v0.4 D1） */}
                {compareSel.length === 2 && (
                  <button
                    type="button"
                    onClick={() => {
                      const a = runById(compareSel[0])
                      const b = runById(compareSel[1])
                      if (a && b) setDiffPair({ a, b })
                    }}
                    className="ml-1 flex shrink-0 items-center gap-1.5 border border-warning/60 bg-warning/10 px-2 py-1 text-[11px] text-warning transition-colors hover:bg-warning/20"
                  >
                    <Icon name="layers" size={11} />
                    {t('studio.compare')}
                  </button>
                )}
                {compareSel.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setCompareSel([])}
                    className="shrink-0 px-1 text-[11px] text-text-disabled hover:text-text-primary"
                  >
                    ✕
                  </button>
                )}
                {p.selectedRun?.output_path && (
                  <button
                    type="button"
                    onClick={() => navigate(`/assets?path=${encodeURIComponent(p.selectedRun!.output_path!)}`)}
                    className="ml-auto flex shrink-0 items-center gap-1 border border-border px-2 py-1 text-[11px] text-text-secondary transition-colors hover:border-primary hover:text-primary"
                  >
                    <Icon name="box" size={11} />
                    {t('studio.openInAssets')}
                  </button>
                )}
              </div>
            </div>
          }
        />
      </div>

      {/* 产物文件预览弹窗 */}
      <FilePreviewModal
        open={fileModal !== null}
        file={fileModal?.file ?? ''}
        content={fileModal?.content ?? ''}
        onClose={() => setFileModal(null)}
      />

      {/* 阶段详情弹窗 */}
      <PhaseDetailModal
        open={phaseDetail !== null}
        phaseKey={phaseDetail ?? ''}
        run={p.runDetail ?? null}
        onClose={() => setPhaseDetail(null)}
        onOpenFile={(file) => {
          if (!p.selectedRun) return
          p.setActiveFile(file)
          void p.refreshFile(p.selectedRun.id, file).then((content) => {
            setFileModal({ file, content })
          })
        }}
        phaseName={p.phaseName}
      />

      {/* 运行产物对比（v0.4 D1） */}
      {diffPair && (
        <RunDiffModal
          runA={diffPair.a}
          runB={diffPair.b}
          onClose={() => {
            setDiffPair(null)
            setCompareSel([])
          }}
        />
      )}
    </>
  )
}

// ================= 运行产物 diff（v0.4 D1） =================

/** 行级 LCS diff：same/del/add 三类行。 */
function diffLines(a: string[], b: string[]): Array<{ type: 'same' | 'del' | 'add'; text: string }> {
  const n = a.length
  const m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out: Array<{ type: 'same' | 'del' | 'add'; text: string }> = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i] })
      i += 1
      j += 1
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: 'del', text: a[i] })
      i += 1
    } else {
      out.push({ type: 'add', text: b[j] })
      j += 1
    }
  }
  while (i < n) {
    out.push({ type: 'del', text: a[i] })
    i += 1
  }
  while (j < m) {
    out.push({ type: 'add', text: b[j] })
    j += 1
  }
  return out
}

/** 两次运行的产物对比弹窗：同名文件选择 + 行级 diff 高亮。 */
function RunDiffModal({
  runA,
  runB,
  onClose,
}: {
  runA: WorkflowRun
  runB: WorkflowRun
  onClose: () => void
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const [files, setFiles] = useState<string[]>([])
  const [file, setFile] = useState('')
  const [aText, setAText] = useState('')
  const [bText, setBText] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const [fa, fb] = await Promise.all([
          studioApi.files(runA.id),
          studioApi.files(runB.id),
        ])
        if (cancelled) return
        const common = fa.files.filter((f) => fb.files.includes(f))
        if (common.length === 0) {
          setLoading(false)
          return
        }
        setFiles(common)
        setFile(common[0])
      } catch (err) {
        if (!cancelled) {
          toast(err instanceof Error ? err.message : String(err), 'error')
          setLoading(false)
        }
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [runA.id, runB.id, toast])

  useEffect(() => {
    if (!file) return
    let cancelled = false
    setLoading(true)
    async function load() {
      try {
        const [ta, tb] = await Promise.all([
          studioApi.readFile(runA.id, file),
          studioApi.readFile(runB.id, file),
        ])
        if (cancelled) return
        setAText(ta)
        setBText(tb)
        setLoading(false)
      } catch (err) {
        if (!cancelled) {
          toast(err instanceof Error ? err.message : String(err), 'error')
          setLoading(false)
        }
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [file, runA.id, runB.id, toast])

  const lines = useMemo(
    () => diffLines(aText.split('\n'), bText.split('\n')),
    [aText, bText],
  )

  return (
    <Modal open onClose={onClose} width={820} title={`${t('studio.compare')} · ${file || ''}`}>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Select
            aria-label={t('studio.compareFile')}
            value={file}
            onChange={(e) => setFile(e.target.value)}
            options={files.map((f) => ({ value: f, label: f }))}
            className="w-64"
          />
          <span className="ml-auto text-[10px] text-text-disabled">
            {t('studio.compareHint')}
          </span>
        </div>
        {loading ? (
          <p className="py-6 text-center text-xs text-text-disabled">{t('studio.loading')}</p>
        ) : files.length === 0 ? (
          <p className="py-6 text-center text-xs text-text-disabled">{t('studio.compareNoCommon')}</p>
        ) : (
          <pre className="max-h-[65vh] overflow-y-auto border border-border font-mono text-[11px] leading-relaxed">
            {lines.map((line, idx) => (
              <div
                key={idx}
                className={`flex gap-2 whitespace-pre-wrap px-2 ${
                  line.type === 'del'
                    ? 'bg-error/15 text-error'
                    : line.type === 'add'
                      ? 'bg-emerald-500/10 text-emerald-400'
                      : 'text-text-secondary'
                }`}
              >
                <span className="w-6 shrink-0 select-none text-right text-text-disabled">
                  {line.type === 'del' ? '-' : line.type === 'add' ? '+' : ''}
                </span>
                <span className="min-w-0 flex-1">{line.text || ' '}</span>
              </div>
            ))}
          </pre>
        )}
      </div>
    </Modal>
  )
}

// ================= 产物文件弹窗 =================

/** Markdown 产物渲染预览（.md 用 react-markdown；其他原样展示）。 */
function FilePreviewModal({ open, file, content, onClose }: { open: boolean; file: string; content: string; onClose: () => void }) {
  const { t } = useTranslation()
  const isMd = file.toLowerCase().endsWith('.md')
  return (
    <Modal open={open} onClose={onClose} width={760} title={file || undefined}>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wide text-text-disabled">
          {isMd ? 'Markdown' : 'Text'}
        </span>
        <CopyButton text={content} label={t('common.copy')} />
      </div>
      {isMd ? (
        <div className="max-h-[70vh] overflow-y-auto p-4">
          <div className="md-body">
            <ReactMarkdown>{content || '—'}</ReactMarkdown>
          </div>
        </div>
      ) : (
        <pre className="max-h-[70vh] overflow-y-auto whitespace-pre-wrap p-3 font-mono text-xs leading-relaxed text-text-primary">
          {content || '—'}
        </pre>
      )}
    </Modal>
  )
}

// ================= 阶段详情弹窗 =================

/**
 * 阶段详情：点步骤条节点查看该阶段的 状态/耗时/错误/产物文件。
 * 数据来自 run 详情接口（phase_done 后自动刷新）。
 */
function PhaseDetailModal({
  open,
  phaseKey,
  run,
  onClose,
  onOpenFile,
  phaseName,
}: {
  open: boolean
  phaseKey: string
  run: ReturnType<typeof useStudioExecution>['runDetail']
  onClose: () => void
  onOpenFile: (file: string) => void
  phaseName: (key: string) => string
}) {
  const { t } = useTranslation()
  const phase = run?.phases?.find((ph) => ph.key === phaseKey) ?? null
  const state = run?.status ?? ''

  return (
    <Modal open={open} onClose={onClose} width={560} title={phaseKey ? `${phaseName(phaseKey)} · 阶段详情` : undefined}>
      <div className="flex flex-col gap-3 p-1">
        {/* 状态 */}
        <div className="flex items-center gap-3">
          <Badge tone={phase?.status === 'completed' ? 'success' : phase?.status === 'failed' ? 'error' : phase?.status === 'running' ? 'primary' : 'neutral'}>
            {phase ? t(`studio.phaseStatus.${phase.status}`) : t(`studio.runStatus.${state}`)}
          </Badge>
          {phase?.duration_ms != null && (
            <span className="text-xs text-text-secondary">
              {t('execution.duration', { ms: phase.duration_ms })}
            </span>
          )}
          {phase?.error && (
            <span className="min-w-0 flex-1 truncate text-xs text-error" title={phase.error}>
              {phase.error}
            </span>
          )}
        </div>

        {/* 错误详情 */}
        {phase?.error && (
          <div className="border border-error/40 bg-error/5 p-3">
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-error">
              {t('execution.error')}
            </p>
            <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-text-primary">
              {phase.error}
            </pre>
          </div>
        )}

        {/* 阶段产物文件 */}
        <div>
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-text-disabled">
            {t('execution.artifacts')}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {p_artifactsFor(phaseKey, run).map((file) => (
              <button
                key={file}
                type="button"
                onClick={() => onOpenFile(file)}
                className="flex items-center gap-1 border border-border px-2 py-1 font-mono text-[11px] text-text-secondary transition-colors hover:border-primary hover:text-primary"
              >
                <Icon name="file" size={11} />
                {file}
              </button>
            ))}
            {p_artifactsFor(phaseKey, run).length === 0 && (
              <span className="text-xs text-text-disabled">{t('execution.noArtifacts')}</span>
            )}
          </div>
        </div>

        {/* 提示 */}
        <p className="text-[10px] leading-relaxed text-text-disabled">{t('execution.phaseDetailHint')}</p>
      </div>
    </Modal>
  )
}

/** 阶段产物文件名：后端 get_run 已按 run 目录真实归属（files 字段）。 */
function p_artifactsFor(phaseKey: string, run: ReturnType<typeof useStudioExecution>['runDetail']): string[] {
  return run?.phases?.find((ph) => ph.key === phaseKey)?.files ?? []
}
