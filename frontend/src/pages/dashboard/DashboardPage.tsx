import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { api, pipelineApi } from '../../api'
import { aiRegistryApi } from '../../api/ai'
import type { PipelineItem } from '../../api/pipeline'
import { Card, Icon } from '../../components/ui'

const STAGES: Array<{ key: string; labelKey: string; tone: string }> = [
  { key: 'discovered', labelKey: 'console.stageCollect', tone: 'bg-text-disabled/50' },
  { key: 'downloaded', labelKey: 'console.stagePreReview', tone: 'bg-primary/70' },
  { key: 'scored', labelKey: 'console.scored', tone: 'bg-primary/70' },
  { key: 'queued', labelKey: 'console.stageAudit', tone: 'bg-primary' },
  { key: 'approved', labelKey: 'console.stagePublish', tone: 'bg-emerald-400' },
  { key: 'published', labelKey: 'console.published', tone: 'bg-emerald-500' },
  { key: 'failed', labelKey: 'console.stageExceptions', tone: 'bg-error/70' },
]

/** 水平条形图（AXIOM 零依赖：纯 CSS，不引入图表库）。 */
function Bar({ value, max, tone, label }: { value: number; max: number; tone: string; label: string }) {
  const pct = max > 0 ? Math.max((value / max) * 100, value > 0 ? 2 : 0) : 0
  return (
    <div className="flex items-center gap-2">
      <span className="w-24 shrink-0 truncate text-right text-[11px] text-text-secondary">{label}</span>
      <div className="relative h-4 min-w-0 flex-1 bg-surface-2">
        <div className={`h-full ${tone}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-14 shrink-0 font-mono text-[11px] text-text-primary">{value}</span>
    </div>
  )
}

/** 趋势直方图（v0.12 重写）：采集/入库/发布 每日并排柱——数据稀疏时
 *  折线贴底不可见，柱状图保持直观（0 值不画柱，网格线兜底刻度）。 */
function TrendChart({ data }: { data: Array<{ date: string; collected: number; inserted: number; published: number }> }) {
  const { t } = useTranslation()
  const W = 600
  const H = 170
  const PAD = 12
  const n = data.length
  const max = Math.max(...data.map((d) => d.collected), ...data.map((d) => d.inserted), ...data.map((d) => d.published), 1)
  const groupW = n > 0 ? (W - PAD * 2) / n : W
  const barW = Math.max(2, Math.min(14, groupW / 3.4))
  const yMax = H - PAD
  const h = (v: number) => (v > 0 ? Math.max(2, (v / max) * (yMax - PAD)) : 0)
  const labelEvery = Math.max(1, Math.ceil(n / 10))
  const SERIES = [
    { key: 'collected' as const, label: 'console.collectedShort', cls: 'fill-[var(--hz-primary,#888)]' },
    { key: 'inserted' as const, label: 'console.insertedShort', cls: 'fill-blue-500' },
    { key: 'published' as const, label: 'console.publishedShort', cls: 'fill-emerald-400' },
  ]

  return (
    <div className="flex flex-col gap-1">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={t('dashboard.trend')}>
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={PAD} x2={W - PAD} y1={PAD + (yMax - PAD) * f} y2={PAD + (yMax - PAD) * f} className="stroke-border/60" strokeWidth={0.5} />
        ))}
        {data.map((d, i) =>
          SERIES.map((s, si) => {
            const v = d[s.key]
            if (v <= 0) return null
            return (
              <rect
                key={`${d.date}-${s.key}`}
                x={PAD + i * groupW + si * barW + (groupW - barW * SERIES.length) / 2}
                y={yMax - h(v)}
                width={barW}
                height={h(v)}
                rx={0.5}
                className={s.cls}
              />
            )
          }),
        )}
        {data.map((d, i) =>
          i % labelEvery === 0 ? (
            <text key={d.date} x={PAD + i * groupW + groupW / 2} y={H - 2} textAnchor="middle" className="fill-text-disabled" fontSize={8}>
              {d.date.slice(5)}
            </text>
          ) : null,
        )}
      </svg>
      <div className="flex flex-wrap items-center gap-3 px-1 text-[10px] text-text-secondary">
        {SERIES.map((s) => (
          <span key={s.key} className="flex items-center gap-1">
            <span className={`inline-block h-1.5 w-4 rounded ${s.cls}`} />
            {t(s.label)}
          </span>
        ))}
      </div>
    </div>
  )
}

/**
 * 看板页（v0.4 C2）：漏斗水位 + 发布统计 + AI 用量聚合。
 * 数据全部来自既有端点（counts/items/trace），前端聚合展示，无新后端。
 */

interface ChannelInsight {
  audience_preferences?: string[]
  hook_styles?: string[]
  avoid_topics?: string[]
  notes?: string
  generated_at?: string
  source_count?: number
}

export function DashboardPage() {
  const { t } = useTranslation()

  const { data: counts = {} } = useQuery({
    queryKey: ['pipeline-counts'],
    queryFn: pipelineApi.counts,
    refetchInterval: 15_000,
  })
  const { data: published = [] } = useQuery({
    queryKey: ['pipeline-stage', 'published'],
    queryFn: () => pipelineApi.items('published', 100),
  })
  const { data: trends = [] } = useQuery({
    queryKey: ['pipeline-trends'],
    queryFn: () => pipelineApi.trends(30),
    refetchInterval: 60_000,
  })
  // 系统评估（v0.12）：发布通道 / 产能 / 队列深度 —— 与 AppShell/执行页共享缓存
  const { data: publishStatus } = useQuery({
    queryKey: ['pipeline-status'],
    queryFn: pipelineApi.publishStatus,
    refetchInterval: 30_000,
  })
  const { data: queueView } = useQuery({
    queryKey: ['publish-queue'],
    queryFn: pipelineApi.queueView,
    refetchInterval: 30_000,
  })
  // 频道洞察（v0.19 数据飞轮）：最新分析快照——Dashboard 数据复盘语境
  const { data: insight, refetch: refetchInsight } = useQuery({
    queryKey: ['channel-insight'],
    queryFn: () => api.get<ChannelInsight | null>('/api/ai/insights'),
    refetchInterval: 300_000,
  })
  const { data: failures = {} } = useQuery({
    queryKey: ['pipeline-failures'],
    queryFn: pipelineApi.failures,
    refetchInterval: 30_000,
  })
  const { data: trace = [] } = useQuery({
    queryKey: ['ai-trace-summary'],
    queryFn: () => aiRegistryApi.trace(undefined, 500),
  })
  // 模型单价（v0.5 E 成本估算）：与设置页共享 ['config'] 缓存
  const { data: cfg } = useQuery({
    queryKey: ['config'],
    queryFn: () =>
      api.get<{ ai_model_prices?: Record<string, { prompt?: number; completion?: number }> }>(
        '/api/config',
      ),
  })

  const maxCount = useMemo(
    () => Math.max(...STAGES.map((s) => counts[s.key] ?? 0), 1),
    [counts],
  )

  // 发布统计（近 30 天）
  const monthAgo = Date.now() - 30 * 24 * 3600 * 1000
  const recent = published.filter((p) => p.published_at && Date.parse(p.published_at) > monthAgo)
  const targetDist = useMemo(() => {
    const map = new Map<string, number>()
    for (const p of recent) {
      const target = String((p.publish_json as Record<string, unknown> | null)?.target ?? 'unknown')
      map.set(target, (map.get(target) ?? 0) + 1)
    }
    return [...map.entries()]
  }, [recent])
  const statsOf = (p: PipelineItem) =>
    (p.publish_json as Record<string, unknown> | null)?.stats as Record<string, number> | null
  const withStats = recent.filter((p) => statsOf(p)?.view != null)
  const avgView = withStats.length
    ? Math.round(withStats.reduce((acc, p) => acc + (statsOf(p)?.view ?? 0), 0) / withStats.length)
    : null

  // AI 用量聚合（按模型）
  const byModel = useMemo(() => {
    const map = new Map<string, { calls: number; ms: number }>()
    for (const call of trace) {
      const key = call.model_key || 'unknown'
      const entry = map.get(key) ?? { calls: 0, ms: 0 }
      entry.calls += 1
      entry.ms += call.duration_ms ?? 0
      map.set(key, entry)
    }
    return [...map.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 8)
  }, [trace])
  const maxMs = Math.max(...byModel.map(([, v]) => v.ms), 1)

  // 成本估算（v0.5 E）：tokens 聚合 × 单价（美元/百万）
  const cost = useMemo(() => {
    const prices = cfg?.ai_model_prices ?? {}
    const perModel = new Map<string, { prompt: number; completion: number; calls: number }>()
    for (const call of trace) {
      const key = call.model_key || 'unknown'
      const entry = perModel.get(key) ?? { prompt: 0, completion: 0, calls: 0 }
      entry.prompt += call.prompt_tokens ?? 0
      entry.completion += call.completion_tokens ?? 0
      entry.calls += 1
      perModel.set(key, entry)
    }
    let total = 0
    const rows: Array<{ model: string; cost: number; tokens: number }> = []
    for (const [model, v] of perModel) {
      const price = prices[model]
      if (!price) continue
      const costUsd =
        (v.prompt / 1_000_000) * (price.prompt ?? 0) +
        (v.completion / 1_000_000) * (price.completion ?? 0)
      total += costUsd
      rows.push({ model, cost: costUsd, tokens: v.prompt + v.completion })
    }
    return { total, rows }
  }, [trace, cfg])

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-6">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
        <h1 className="text-base font-semibold text-text-primary">{t('dashboard.title')}</h1>

        {/* 频道洞察（v0.19 数据飞轮）：AI 基于发布表现总结受众偏好 */}
        {insight && (
          <Card className="p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="flex items-center gap-1.5 text-xs font-medium text-text-primary">
                <Icon name="wand" size={13} className="text-primary" />
                {t('dashboard.insightTitle')}
                {insight.generated_at && (
                  <span className="text-[10px] text-text-disabled">{insight.generated_at}</span>
                )}
              </h3>
              <button
                type="button"
                onClick={async () => {
                  await api.post('/api/ai/insights/generate')
                  void refetchInsight()
                }}
                className="text-[11px] text-text-secondary transition-colors hover:text-primary"
              >
                ↻ {t('dashboard.insightRegenerate')}
              </button>
            </div>
            <ul className="space-y-1 text-[11px] leading-relaxed text-text-secondary">
              {(insight.audience_preferences ?? []).slice(0, 3).map((v) => (
                <li key={v}>· {t('dashboard.insightPref')}: {v}</li>
              ))}
              {(insight.avoid_topics ?? []).slice(0, 2).map((v) => (
                <li key={v} className="text-warning/90">· {t('dashboard.insightAvoid')}: {v}</li>
              ))}
              {insight.notes && <li className="text-text-primary">· {insight.notes}</li>}
            </ul>
          </Card>
        )}

        {/* 系统评估（v0.12 置顶）：发布通道 / 自动产能 / 队列深度——第一屏总览 */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Card className="p-3">
            <h3 className="mb-2 flex items-center gap-1.5 text-xs font-medium text-text-primary">
              <Icon name="send" size={13} className="text-primary" />
              {t('dashboard.publishChannel')}
            </h3>
            {publishStatus ? (
              <dl className="space-y-1.5 text-[11px]">
                <div className="flex items-center justify-between">
                  <dt className="text-text-disabled">{t('dashboard.target')}</dt>
                  <dd className="font-mono text-text-secondary">{publishStatus.target}</dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt className="text-text-disabled">biliup</dt>
                  <dd className="font-mono">{publishStatus.biliup_available ? '✓' : '✗'}</dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt className="text-text-disabled">{t('dashboard.cookie')}</dt>
                  <dd className="font-mono">{publishStatus.cookie_exists ? '✓' : '✗'}</dd>
                </div>
                {publishStatus.noop && (
                  <p className="pt-1 text-[10px] leading-relaxed text-warning">
                    {t('dashboard.noopWarning')}
                  </p>
                )}
              </dl>
            ) : (
              <p className="text-[11px] text-text-disabled">{t('common.loading')}</p>
            )}
          </Card>

          <Card className="p-3">
            <h3 className="mb-2 flex items-center gap-1.5 text-xs font-medium text-text-primary">
              <Icon name="clock" size={13} className="text-primary" />
              {t('dashboard.autoPublish')}
            </h3>
            {queueView ? (
              <>
                <div className="flex items-baseline justify-between text-[11px]">
                  <span className="text-text-disabled">{t('dashboard.todayCapacity')}</span>
                  <span className="font-mono text-text-secondary">
                    {queueView.today.auto_published} / {queueView.today.daily_limit}
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2">
                  <div
                    className={`h-full transition-all ${
                      queueView.today.auto_enabled
                        ? queueView.today.auto_published >= queueView.today.daily_limit
                          ? 'bg-error/70'
                          : 'bg-primary'
                        : 'bg-text-disabled/40'
                    }`}
                    style={{
                      width: `${Math.min(
                        100,
                        Math.round(
                          (queueView.today.auto_published / Math.max(1, queueView.today.daily_limit)) * 100,
                        ),
                      )}%`,
                    }}
                  />
                </div>
                <p className="mt-1.5 text-[10px] text-text-disabled">
                  {queueView.today.auto_enabled
                    ? t('dashboard.autoPublishOn')
                    : t('dashboard.autoPublishOff')}
                </p>
              </>
            ) : (
              <p className="text-[11px] text-text-disabled">{t('common.loading')}</p>
            )}
          </Card>

          <Card className="p-3">
            <h3 className="mb-2 flex items-center gap-1.5 text-xs font-medium text-text-primary">
              <Icon name="layers" size={13} className="text-primary" />
              {t('dashboard.queueDepth')}
            </h3>
            {queueView ? (
              <dl className="space-y-1.5 text-[11px]">
                <div className="flex items-center justify-between">
                  <dt className="text-text-disabled">{t('dashboard.queueReady')}</dt>
                  <dd className="font-mono text-emerald-400">{queueView.ready.length}</dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt className="text-text-disabled">{t('dashboard.queueHolding')}</dt>
                  <dd className="font-mono text-text-secondary">{queueView.holding.length}</dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt className="text-text-disabled">{t('dashboard.queueTotal')}</dt>
                  <dd className="font-mono text-text-secondary">
                    {queueView.ready.length + queueView.holding.length}
                  </dd>
                </div>
              </dl>
            ) : (
              <p className="text-[11px] text-text-disabled">{t('common.loading')}</p>
            )}
          </Card>
        </div>

        {/* 近 30 天趋势（v0.12：直方图） */}
        <Card className="p-4">
          <h2 className="mb-3 text-sm font-semibold text-text-primary">{t('dashboard.trend')}</h2>
          <TrendChart data={trends} />
        </Card>

        {/* 漏斗水位 */}
        <Card className="p-4">
          <h2 className="mb-3 text-sm font-semibold text-text-primary">{t('dashboard.funnel')}</h2>
          <div className="flex flex-col gap-1.5">
            {STAGES.map((s) => (
              <Bar
                key={s.key}
                label={t(s.labelKey)}
                value={counts[s.key] ?? 0}
                max={maxCount}
                tone={s.tone}
              />
            ))}
          </div>
        </Card>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {/* 发布统计 */}
          <Card className="p-4">
            <h2 className="mb-3 text-sm font-semibold text-text-primary">{t('dashboard.publish')}</h2>
            <dl className="space-y-2 text-xs">
              <div className="flex justify-between">
                <dt className="text-text-secondary">{t('dashboard.publish30d')}</dt>
                <dd className="font-mono text-text-primary">{recent.length}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-text-secondary">{t('dashboard.avgView')}</dt>
                <dd className="font-mono text-text-primary">
                  {avgView != null ? avgView.toLocaleString() : '—'}
                  {withStats.length > 0 && (
                    <span className="ml-1 text-[10px] text-text-disabled">({withStats.length} 条有数据)</span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="mb-1 text-text-secondary">{t('dashboard.targetDist')}</dt>
                {targetDist.length === 0 ? (
                  <dd className="text-text-disabled">—</dd>
                ) : (
                  <dd className="flex flex-wrap gap-1.5">
                    {targetDist.map(([target, n]) => (
                      <span key={target} className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-text-secondary">
                        {target} × {n}
                      </span>
                    ))}
                  </dd>
                )}
              </div>
            </dl>
          </Card>

          {/* AI 用量 */}
          <Card className="p-4">
            <h2 className="mb-3 text-sm font-semibold text-text-primary">{t('dashboard.usage')}</h2>
            {byModel.length === 0 ? (
              <p className="text-xs text-text-disabled">{t('dashboard.usageEmpty')}</p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {byModel.map(([model, v]) => (
                  <Bar
                    key={model}
                    label={model}
                    value={v.ms}
                    max={maxMs}
                    tone="bg-primary/60"
                  />
                ))}
                <p className="pt-1 text-[10px] text-text-disabled">
                  {t('dashboard.usageHint', { calls: trace.length })}
                </p>
              </div>
            )}
          </Card>

          {/* 失败分布（v0.12）：按错误类聚合——系统健康评估维度 */}
          <Card className="p-4">
            <h2 className="mb-3 text-sm font-semibold text-text-primary">{t('dashboard.failures')}</h2>
            {Object.keys(failures).length === 0 ? (
              <p className="text-xs text-text-disabled">{t('dashboard.failuresEmpty')}</p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {Object.entries(failures)
                  .sort((a, b) => b[1] - a[1])
                  .map(([cls, n]) => (
                    <div key={cls} className="flex items-center justify-between text-xs">
                      <span className="min-w-0 truncate font-mono text-text-secondary">{cls}</span>
                      <span className="shrink-0 font-mono text-text-disabled">{n}</span>
                    </div>
                  ))}
              </div>
            )}
          </Card>

          {/* 成本估算（v0.5 E） */}
          <Card className="p-4">
            <h2 className="mb-3 text-sm font-semibold text-text-primary">{t('dashboard.cost')}</h2>
            {cost.rows.length === 0 ? (
              <p className="text-xs text-text-disabled">{t('dashboard.costEmpty')}</p>
            ) : (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-baseline justify-between border-b border-border/60 pb-1.5">
                  <span className="text-xs text-text-secondary">{t('dashboard.costTotal')}</span>
                  <span className="font-mono text-sm text-text-primary">
                    ${cost.total.toFixed(4)}
                  </span>
                </div>
                {cost.rows.map((r) => (
                  <div key={r.model} className="flex items-center justify-between text-xs">
                    <span className="min-w-0 truncate font-mono text-text-secondary">{r.model}</span>
                    <span className="shrink-0 text-text-disabled">
                      {r.tokens.toLocaleString()} tok · ${r.cost.toFixed(4)}
                    </span>
                  </div>
                ))}
                <p className="pt-1 text-[10px] text-text-disabled">{t('dashboard.costHint')}</p>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  )
}
