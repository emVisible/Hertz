import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { PipelineItem } from '../../api'
import {
  Badge,
  Button,
  Icon,
  QueryErrorState,
  Select,
  TabBar,
} from '../../components/ui'
import {
  AuditCard,
  CommandDeck,
  HistoryList,
  PIPELINE_ITEM_TONE,
  PipelineStage,
  PreReviewCard,
  PublishCard,
  SectionCard,
  StageItemRow,
  StageList,
  Terminal,
} from '../../components/execution'
import { CalendarView } from './CalendarView'
import { usePipelineExecution } from '../../hooks/usePipelineExecution'
import { useModelSwitch } from '../../hooks/useModelSwitch'

const JOB_TONE: Record<string, 'neutral' | 'success' | 'error'> = {
  completed: 'success',
  failed: 'error',
  running: 'neutral',
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
  stageError: boolean
  refetchStage: () => void
  stageDiscovered: ReturnType<typeof usePipelineExecution>['stageDiscovered']
  stageDownloaded: ReturnType<typeof usePipelineExecution>['stageDownloaded']
  stageScored: ReturnType<typeof usePipelineExecution>['stageScored']
  stageQueued: ReturnType<typeof usePipelineExecution>['stageQueued']
  stageApproved: ReturnType<typeof usePipelineExecution>['stageApproved']
  stageFailed: ReturnType<typeof usePipelineExecution>['stageFailed']
  stageRejected: ReturnType<typeof usePipelineExecution>['stageRejected']
  stagePublished: ReturnType<typeof usePipelineExecution>['stagePublished']
  tab: string
  setTab: (v: string) => void
  jobs: ReturnType<typeof usePipelineExecution>['jobs']
  sources: ReturnType<typeof usePipelineExecution>['sources']
  failures: Record<string, number>
  supplyWarnings: string[]
  logs: ReturnType<typeof usePipelineExecution>['logs']
  run: () => void
  stop: () => void
  act: (item: PipelineItem, action: 'approve' | 'reject' | 'retry' | 'requeue') => void
  saveMeta: (item: PipelineItem, meta: Record<string, string | number | null>) => Promise<void>
  publishItem: (item: PipelineItem, selfmade?: boolean) => void
  retryClass: (cls: string, n: number) => void
  modelSwitch: ReturnType<typeof useModelSwitch>
}

type PipelineTabId = 'run' | 'preReview' | 'inReview' | 'postReview'

// 第三级路由：内容流水线平铺菜单（v0.2.0 审核三态）——
// 运行（操作）｜审核前（discovered/downloaded/scored 合并展示，单条数据审核前状态）
// ｜审核中（queued 审核操作）｜审核后（approved 发布操作 + published 历史 + 异常恢复）
const PIPELINE_TABS = [
  { id: 'run', labelKey: 'execution.modePipeline' },
  { id: 'preReview', labelKey: 'console.stagePreReview', countKeys: ['discovered', 'downloaded', 'scored'] },
  { id: 'inReview', labelKey: 'console.stageAudit', countKeys: ['queued'] },
  { id: 'postReview', labelKey: 'console.stagePostReview', countKeys: ['approved', 'published'] },
] satisfies Array<{
  id: PipelineTabId
  labelKey: string
  countKeys?: string[]
}>

export function PipelineView(p: PipelineViewProps) {
  const { t } = useTranslation()
  // 发布 tab 视图：列表（默认）｜内容日历（v0.2.3）
  const [calendarView, setCalendarView] = useState(false)
  const pTab: PipelineTabId = PIPELINE_TABS.some((tb) => tb.id === p.tab)
    ? (p.tab as PipelineTabId)
    : 'inReview'

  const tabItems = PIPELINE_TABS.map((tb) => ({
    id: tb.id,
    label: t(tb.labelKey),
    count: tb.countKeys
      ? tb.countKeys.reduce((sum, k) => sum + (p.counts[k] ?? 0), 0)
      : undefined,
  }))

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 平铺菜单栏（第三级路由）：TabBar 统一语言 */}
      <div className="shrink-0 border-b border-border px-4">
        <TabBar items={tabItems} active={pTab} onChange={p.setTab} />
      </div>

      {/* 内容区（当前部分，独立滚动） */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {pTab === 'run' && (
          <div className="flex min-h-full flex-col gap-4 p-4">
            <CommandDeck
              title={t('execution.modePipeline')}
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
                      { value: 'collect', label: 'collect' },
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
                  {/* 流水线运行时默认 AI（v0.2.0）：绑定评分角色 fast */}
                  <Select
                    label={t('console.defaultAi')}
                    value={p.modelSwitch.current}
                    onChange={(e) => void p.modelSwitch.switchModel(e.target.value)}
                    options={[
                      { value: '', label: t('console.aiFollowDefault') },
                      ...p.modelSwitch.chatModels,
                    ]}
                    className="w-64"
                  />
                  {p.running && (
                    <p className="pb-1 text-xs text-text-secondary">{p.statusJob}</p>
                  )}
                </div>
              }
            />

            {/* 日志/采集源/任务：与 Studio 一致——flex 布局，Terminal 随容器伸展内部滚动 */}
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
                {/* 供给告警（参考原项目漏斗水位）：源头出问题时一眼可见 */}
                {p.supplyWarnings.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 border border-warning/30 bg-warning/10 px-2.5 py-1.5">
                    {p.supplyWarnings.map((w) => (
                      <span key={w} className="text-[11px] text-warning">{t(`console.supply.${w}`)}</span>
                    ))}
                  </div>
                )}
                <SectionCard title={t('console.sources')} padded={false} className="shrink-0">
                  <ul className="max-h-40 space-y-1 overflow-y-auto p-3 text-xs">
                    {p.sources.length === 0 && <p className="text-text-disabled">{t('console.noSources')}</p>}
                    {p.sources.map((s) => (
                      <li key={`${s.source}:${s.channel}`} className="flex items-center justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span
                            title={t(`console.sourceHealth.${s.health}`)}
                            className={`h-2 w-2 shrink-0 rounded-full ${
                              s.health === 'healthy'
                                ? 'bg-emerald-400'
                                : s.health === 'degraded'
                                  ? 'bg-warning'
                                  : 'bg-error'
                            }`}
                          />
                          <span className="truncate">{s.source}:{s.channel}</span>
                        </span>
                        <span
                          className="shrink-0 text-text-secondary"
                          title={s.last_error ?? undefined}
                        >
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
          </div>
        )}

        {pTab === 'preReview' && (
          <div className="p-4">
            <PipelineStage title={t('console.stagePreReview')}>
              {/* 审核前混合列表：单条数据聚合下载/评分/制作信息（v0.2.0） */}
              <StageList
                items={[
                  ...p.stageDiscovered,
                  ...p.stageDownloaded,
                  ...p.stageScored,
                ].sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))}
                emptyText={t('console.emptyPreReview')}
                total={(p.counts.discovered ?? 0) + (p.counts.downloaded ?? 0) + (p.counts.scored ?? 0)}
                renderRow={(item) => <PreReviewCard key={item.id} item={item} />}
              />
            </PipelineStage>
          </div>
        )}
        {pTab === 'inReview' && (
          <div className="p-4">
            <PipelineStage
              title={t('console.stageAudit')}
              isEmpty={p.stageQueued.length === 0}
              emptyText={t('console.emptyAudit')}
            >
              <ul className="divide-y divide-border/60">
                {p.stageQueued.map((item) => (
                  <AuditCard
                    key={item.id}
                    item={item}
                    onApprove={(i) => void p.act(i, 'approve')}
                    onReject={(i) => void p.act(i, 'reject')}
                    onSaveMeta={(i, meta) => p.saveMeta(i, meta)}
                  />
                ))}
              </ul>
            </PipelineStage>

            {/* 异常内容（failed / rejected）：独立查询，可重试/恢复待审 */}
            <div className="mt-4">
              <SectionCard title={t('console.exceptions')} padded={false}>
                {p.stageError ? (
                  <QueryErrorState message={t('error.queryFailed', { detail: 'pipeline' })} onRetry={() => void p.refetchStage()} />
                ) : p.stageFailed.length + p.stageRejected.length === 0 ? (
                  <p className="p-3 text-sm text-text-disabled">{t('console.noExceptions')}</p>
                ) : (
                  <>
                    {/* 失败分类看板（v0.2.1）：按类统计 + 同类批量重试 */}
                    {Object.keys(p.failures).length > 0 && (
                      <div className="flex flex-wrap items-center gap-1.5 border-b border-border/60 px-3 py-2">
                        {Object.entries(p.failures).map(([cls, n]) => (
                          <span key={cls} className="inline-flex items-center gap-1.5 border border-border bg-surface-2/60 px-2 py-0.5 text-[11px] text-text-secondary">
                            <span className="font-mono">{cls}</span>
                            <span className="text-text-disabled">{n}</span>
                            <button
                              type="button"
                              onClick={() => void p.retryClass(cls, n)}
                              title={t('console.retryClassHint', { cls })}
                              className=" p-0.5 text-text-disabled transition-colors hover:text-primary"
                            >
                              <Icon name="refresh" size={11} />
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                    <StageList
                      items={[...p.stageRejected, ...p.stageFailed]}
                      emptyText={t('console.noExceptions')}
                      total={(p.counts.rejected ?? 0) + (p.counts.failed ?? 0)}
                      renderRow={(item) => (
                        <StageItemRow
                          item={item}
                          badge={<Badge tone={PIPELINE_ITEM_TONE[item.status] ?? 'neutral'}>{item.status}</Badge>}
                          right={
                            item.status === 'failed' ? (
                              <Button size="sm" variant="ghost" onClick={() => void p.act(item, 'retry')}>
                                {t('common.retry')}
                              </Button>
                            ) : (
                              <Button size="sm" variant="ghost" onClick={() => void p.act(item, 'requeue')}>
                                {t('console.restore')}
                              </Button>
                            )
                          }
                        />
                      )}
                    />
                  </>
                )}
              </SectionCard>
            </div>
          </div>
        )}

        {pTab === 'postReview' && (
          <div className="flex flex-col gap-4 p-4">
            {/* 视图切换：列表（默认）｜内容日历（v0.2.3，Buffer/新榜同款） */}
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setCalendarView(false)}
                className={`px-2.5 py-1 text-xs transition-colors ${
                  !calendarView
                    ? 'bg-surface-2 font-medium text-text-primary'
                    : 'text-text-secondary hover:bg-surface-2/60'
                }`}
              >
                {t('console.calendarList')}
              </button>
              <button
                type="button"
                onClick={() => setCalendarView(true)}
                className={`px-2.5 py-1 text-xs transition-colors ${
                  calendarView
                    ? 'bg-surface-2 font-medium text-text-primary'
                    : 'text-text-secondary hover:bg-surface-2/60'
                }`}
              >
                {t('console.calendar')}
              </button>
            </div>

            {calendarView ? (
              <CalendarView
                onSaveSchedule={(item, value) => p.saveMeta(item, { scheduled_at: value })}
              />
            ) : (              <>
            {/* 审核后：approved（发布操作） */}
            <PipelineStage
              title={t('console.stagePublish')}
              isEmpty={p.stageApproved.length === 0}
              emptyText={t('console.emptyPublish')}
            >
              <ul className="divide-y divide-border/60">
                {p.stageApproved.map((item) => (
                  <PublishCard
                    key={item.id}
                    item={item}
                    onPublish={(i, selfmade) => p.publishItem(i, selfmade)}
                    onSaveMeta={(i, meta) => p.saveMeta(i, meta)}
                    onRequeue={(i) => void p.act(i, 'requeue')}
                  />
                ))}
              </ul>
              <p className="border-t border-border/60 px-3 py-2 text-[10px] text-text-disabled">
                {t('console.publishHint')}
              </p>
            </PipelineStage>

            {/* 最近发布（published）：可重新发布 */}
            <div className="mt-4">
              <SectionCard title={t('console.recentPublishes')} padded={false}>
                {p.stagePublished.length === 0 ? (
                  <p className="p-3 text-sm text-text-disabled">{t('console.noPublishes')}</p>
                ) : (
                  <StageList
                    items={p.stagePublished}
                    emptyText={t('console.noPublishes')}
                    renderRow={(item) => (
                      <StageItemRow
                        item={item}
                        badge={<Badge tone="success">published</Badge>}
                        right={
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => void p.publishItem(item, false)}
                            title={t('console.republishHint')}
                          >
                            {t('console.republish')}
                          </Button>
                        }
                      />
                    )}
                  />
                )}
              </SectionCard>
            </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

