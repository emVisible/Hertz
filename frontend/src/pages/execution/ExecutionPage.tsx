import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'

import {
  Badge,
  Button,
  Icon,
  QueryErrorState,
  Select,
} from '../../components/ui'
import {
  CommandDeck,
  HistoryList,
  ProgressStrip,
  SectionCard,
  StatusSteps,
  Terminal,
} from '../../components/execution'
import { useStudioExecution } from '../../hooks/useStudioExecution'
import { usePipelineExecution } from '../../hooks/usePipelineExecution'
import { useModelSwitch } from '../../hooks/useModelSwitch'
import { Modal } from '../../components/ui'

const STUDIO_PHASE_DOT: Record<string, string> = {
  pending: 'bg-text-disabled/40',
  running: 'animate-pulse bg-primary',
  completed: 'bg-success',
  failed: 'bg-error',
}

const PIPELINE_ITEM_TONE: Record<string, 'neutral' | 'success' | 'error' | 'warning' | 'primary'> = {
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

const RUN_TONE: Record<string, 'neutral' | 'success' | 'error' | 'warning' | 'primary'> = {
  running: 'primary',
  completed: 'success',
  failed: 'error',
  cancelled: 'warning',
}

type Mode = 'studio' | 'pipeline'

export function ExecutionPage() {
  const { t } = useTranslation()
  const [params, setParams] = useSearchParams()
  const [mode, setModeState] = useState<Mode>(() => (params.get('mode') === 'pipeline' ? 'pipeline' : 'studio'))

  const studio = useStudioExecution()
  const pipeline = usePipelineExecution()
  const modelSwitch = useModelSwitch()

  function setMode(m: Mode) {
    setModeState(m)
    setParams(m === 'pipeline' ? { mode: 'pipeline' } : {}, { replace: true })
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-hidden p-4">
      {/* 模式切换 */}
      <div className="flex shrink-0 border border-border self-start">
        {(
          [
            { id: 'studio', label: t('execution.modeStudio') },
            { id: 'pipeline', label: t('execution.modePipeline') },
          ] as Array<{ id: Mode; label: string }>
        ).map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setMode(tab.id)}
            className={`px-4 py-1.5 text-xs font-medium transition-colors ${
              mode === tab.id
                ? 'bg-primary/10 text-text-primary'
                : 'text-text-secondary hover:bg-surface-2'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {mode === 'studio' ? (
        <StudioView
          plans={studio.plans}
          planId={studio.planId}
          setPlanId={studio.setPlanId}
          topic={studio.topic}
          setTopic={studio.setTopic}
          running={studio.running}
          logs={studio.logs}
          phaseStates={studio.phaseStates}
          runs={studio.runs}
          runningPhase={studio.runningPhase}
          planPhases={studio.planPhases}
          selectedRun={studio.selectedRun}
          activeFile={studio.activeFile}
          setActiveFile={studio.setActiveFile}
          fileContent={studio.fileContent}
          statusText={studio.statusText}
          phaseName={studio.phaseName}
          run={studio.run}
          stop={studio.stop}
          selectRun={studio.selectRun}
          refreshFile={studio.refreshFile}
          modelSwitch={modelSwitch}
          runDetail={studio.runDetail}
          buffs={studio.buffs}
          buffKeys={studio.buffKeys}
          setBuffKeys={studio.setBuffKeys}
        />
      ) : (
        <PipelineView
          step={pipeline.step}
          setStep={pipeline.setStep}
          limit={pipeline.limit}
          setLimit={pipeline.setLimit}
          steps={pipeline.steps}
          running={pipeline.running}
          statusJob={pipeline.status?.job ?? ''}
          counts={pipeline.counts}
          items={pipeline.items}
          itemsError={pipeline.itemsError}
          refetchItems={pipeline.refetchItems}
          jobs={pipeline.jobs}
          sources={pipeline.sources}
          logs={pipeline.logs}
          run={pipeline.run}
          stop={pipeline.stop}
          act={pipeline.act}
        />
      )}
    </div>
  )
}

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
}

function StudioView(p: StudioViewProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [fileModal, setFileModal] = useState<{ file: string; content: string } | null>(null)
  const [phaseDetail, setPhaseDetail] = useState<string | null>(null)
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
            {/* Buff / Debuff 多选（v5.2）：Buff 一行、Debuff 一行，无框纯文字，过长横向滑动 */}
            {p.buffs.length > 0 && (
              <div className="flex flex-col gap-1 border-t border-border pt-2">
                {/* 第一行：Buff（正向） */}
                <div className="flex items-baseline gap-2">
                  <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-text-disabled">
                    {t('studio.buffs')}
                  </span>
                  <div className="scrollbar-none flex min-w-0 flex-1 items-center gap-3 overflow-x-auto">
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
                          className={`shrink-0 whitespace-nowrap text-[11px] transition-colors ${
                            active
                              ? 'font-medium text-text-primary'
                              : 'text-text-disabled hover:text-text-secondary'
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
                        className={`shrink-0 whitespace-nowrap text-[11px] transition-colors ${
                          p.buffKeys.includes('random')
                            ? 'font-medium text-warning'
                            : 'text-text-disabled hover:text-text-secondary'
                        }`}
                      >
                        🎲 {t('studio.buffRandom')}
                      </button>
                    )}
                  </div>
                </div>
                {/* 第二行：Debuff（反向禁忌，中性色与 Buff 对齐） */}
                {p.buffs.some((b) => b.polarity === 'debuff' && b.enabled) && (
                  <div className="flex items-baseline gap-2">
                    <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-text-disabled">
                      {t('studio.debuffs')}
                    </span>
                    <div className="scrollbar-none flex min-w-0 flex-1 items-center gap-3 overflow-x-auto">
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
                            className={`shrink-0 whitespace-nowrap text-[11px] transition-colors ${
                              active
                                ? 'font-medium text-text-primary'
                                : 'text-text-disabled hover:text-text-secondary'
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
                {p.runs.map((run) => (
                  <button
                    key={run.id}
                    type="button"
                    onClick={() => p.selectRun(run.id)}
                    className={`flex shrink-0 items-center gap-1.5 border px-2 py-1 text-[11px] transition-colors ${
                      p.selectedRun?.id === run.id
                        ? 'border-primary bg-primary/10 text-text-primary'
                        : 'border-border text-text-secondary hover:bg-surface-2'
                    }`}
                  >
                    <Badge tone={RUN_TONE[run.status] ?? 'neutral'}>{t(`studio.runStatus.${run.status}`)}</Badge>
                    <span className="max-w-40 truncate">
                      {(run.context.topic as string) ?? run.id.slice(0, 8)}
                    </span>
                  </button>
                ))}
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
    </>
  )
}

// ================= 产物文件弹窗 =================

/** Markdown 产物渲染预览（.md 用 react-markdown；其他原样展示）。 */
function FilePreviewModal({ open, file, content, onClose }: { open: boolean; file: string; content: string; onClose: () => void }) {
  const isMd = file.toLowerCase().endsWith('.md')
  return (
    <Modal open={open} onClose={onClose} width={760} title={file || undefined}>
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

// ================= Pipeline 域 =================

interface PipelineViewProps {
  step: string
  setStep: (v: string) => void
  limit: number
  setLimit: (v: number) => void
  steps: string[]
  running: boolean
  statusJob: string
  counts: Record<string, number>
  items: ReturnType<typeof usePipelineExecution>['items']
  itemsError: boolean
  refetchItems: () => void
  jobs: ReturnType<typeof usePipelineExecution>['jobs']
  sources: ReturnType<typeof usePipelineExecution>['sources']
  logs: ReturnType<typeof usePipelineExecution>['logs']
  run: () => void
  stop: () => void
  act: (item: ReturnType<typeof usePipelineExecution>['items'][number], action: 'approve' | 'reject' | 'retry') => void
}

function PipelineView(p: PipelineViewProps) {
  const { t } = useTranslation()
  return (
    <>
      <CommandDeck
        title={t('console.title')}
        icon="console"
        running={p.running}
        onRun={p.run}
        onStop={p.stop}
        runDisabled={!p.step}
        controls={
          <div className="flex flex-wrap items-end gap-3">
            <Select
              label={t('console.step')}
              value={p.step}
              onChange={(e) => p.setStep(e.target.value)}
              options={[
                { value: 'chain', label: t('console.chain') },
                ...p.steps.map((s) => ({ value: s, label: s })),
              ]}
              className="w-44"
            />
            <Select
              label={t('console.limit')}
              value={String(p.limit)}
              onChange={(e) => p.setLimit(Number(e.target.value))}
              options={[5, 10, 25, 50].map((n) => ({ value: String(n), label: String(n) }))}
              className="w-28"
            />
            {p.running && (
              <p className="pb-1 text-xs text-text-secondary">{p.statusJob}</p>
            )}
          </div>
        }
      />

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-3">
        <Terminal
          title={t('console.logs')}
          lines={p.logs}
          streaming={p.running}
          kindClass={(kind) =>
            kind === 'done' ? 'font-semibold text-error' : kind === 'item' ? 'text-text-primary' : 'text-text-secondary'
          }
        />

        <div className="flex min-h-0 flex-col gap-4">
          <SectionCard
            title={t('execution.sources')}
            padded={false}
            className="shrink-0"
          >
            <ul className="max-h-40 space-y-1 overflow-y-auto p-3 text-xs">
              {p.sources.length === 0 && <p className="text-text-disabled">{t('console.noSources')}</p>}
              {p.sources.map((s) => (
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
          </SectionCard>

          <HistoryList
            title={t('console.jobs')}
            items={p.jobs.map((job) => ({
              id: job.id,
              title: job.job,
              tone: JOB_TONE[job.status] ?? 'neutral',
              statusLabel: job.status,
            }))}
            emptyText={t('console.noJobs')}
            onSelect={() => undefined}
          />
        </div>
      </div>

      {/* 审核队列（域专属） */}
      <SectionCard
        title={t('console.reviewQueue')}
        padded={false}
        className="shrink-0"
        right={
          <div className="flex gap-2 text-xs text-text-secondary">
            {['discovered', 'scored', 'downloaded', 'queued', 'approved', 'published', 'rejected', 'failed'].map(
              (s) => (
                <span key={s} className="flex items-center gap-1">
                  <Badge tone={PIPELINE_ITEM_TONE[s]}>{s}</Badge>
                  {p.counts[s] ?? 0}
                </span>
              ),
            )}
          </div>
        }
      >
        <div className="min-h-0 flex-1 overflow-y-auto">
          {p.itemsError ? (
            <QueryErrorState message={t('error.queryFailed', { detail: 'pipeline' })} onRetry={() => void p.refetchItems()} />
          ) : p.items.length === 0 ? (
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
                {p.items.map((item) => (
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
                      <Badge tone={PIPELINE_ITEM_TONE[item.status]}>{item.status}</Badge>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex gap-1.5">
                        {item.status === 'queued' && (
                          <Button size="sm" onClick={() => void p.act(item, 'approve')}>
                            <Icon name="check" size={12} />
                            {t('console.approve')}
                          </Button>
                        )}
                        {(item.status === 'queued' || item.status === 'scored' || item.status === 'downloaded') && (
                          <Button size="sm" variant="danger" onClick={() => void p.act(item, 'reject')}>
                            <Icon name="close" size={12} />
                            {t('console.reject')}
                          </Button>
                        )}
                        {item.status === 'failed' && (
                          <Button size="sm" variant="ghost" onClick={() => void p.act(item, 'retry')}>
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
      </SectionCard>
    </>
  )
}
