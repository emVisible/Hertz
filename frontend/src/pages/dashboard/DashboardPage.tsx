import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { api, pipelineApi } from '../../api'
import { aiRegistryApi } from '../../api/ai'
import type { PipelineItem } from '../../api/pipeline'
import { Card } from '../../components/ui'

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

/** 趋势折线（v0.5 B）：纯 SVG 手写折线，零图表依赖。 */
function TrendChart({ data }: { data: Array<{ date: string; collected: number; inserted: number; published: number }> }) {
  const { t } = useTranslation()
  const W = 600
  const H = 160
  const PAD = 8
  const max = Math.max(...data.map((d) => d.collected), ...data.map((d) => d.inserted), 1)
  const n = data.length
  const x = (i: number) => (n <= 1 ? PAD : PAD + (i * (W - PAD * 2)) / (n - 1))
  const y = (v: number) => H - PAD - (v / max) * (H - PAD * 2)
  const path = (pick: (d: (typeof data)[number]) => number) =>
    data.map((d, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(pick(d)).toFixed(1)}`).join(' ')
  const labelEvery = Math.max(1, Math.ceil(n / 8))

  return (
    <div className="flex flex-col gap-1">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={t('dashboard.trend')}>
        {/* 网格线 */}
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={PAD} x2={W - PAD} y1={y(max * f)} y2={y(max * f)} className="stroke-border/60" strokeWidth={0.5} />
        ))}
        <polyline points={path((d) => d.collected)} fill="none" stroke="var(--hz-primary, #888)" strokeWidth={1.6} strokeLinejoin="round" />
        <polyline points={path((d) => d.inserted)} fill="none" stroke="#3b82f6" strokeWidth={1.6} strokeLinejoin="round" />
        <polyline points={path((d) => d.published)} fill="none" stroke="#34d399" strokeWidth={1.6} strokeLinejoin="round" />
        {/* 日期轴 */}
        {data.map((d, i) =>
          i % labelEvery === 0 ? (
            <text key={d.date} x={x(i)} y={H - 2} textAnchor="middle" className="fill-text-disabled" fontSize={8}>
              {d.date.slice(5)}
            </text>
          ) : null,
        )}
      </svg>
      <div className="flex flex-wrap items-center gap-3 px-1 text-[10px] text-text-secondary">
        <span className="flex items-center gap-1"><span className="inline-block h-1.5 w-4 rounded bg-[var(--hz-primary,#888)]" />{t('console.collectedShort')}</span>
        <span className="flex items-center gap-1"><span className="inline-block h-1.5 w-4 rounded bg-blue-500" />{t('console.insertedShort')}</span>
        <span className="flex items-center gap-1"><span className="inline-block h-1.5 w-4 rounded bg-emerald-400" />{t('console.publishedShort')}</span>
      </div>
    </div>
  )
}

/**
 * 看板页（v0.4 C2）：漏斗水位 + 发布统计 + AI 用量聚合。
 * 数据全部来自既有端点（counts/items/trace），前端聚合展示，无新后端。
 */
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

        {/* 近 30 天趋势（v0.5 B） */}
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
