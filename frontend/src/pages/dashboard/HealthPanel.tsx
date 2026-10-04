/** 看板 · 成本与健康栏（v0.34 重设计）：这台机器最近干得怎么样、花了多少、哪儿在坏。
 *
 * 只读。和供给栏一样不复制写入口——要改发布配置去设置，要重跑采集去流水线。
 *
 * 合并依据：原来三张「发布」小卡（通道 / 自动产能 / 队列深度）读的是同两个端点，
 * 回答的是同一个问题（今天还能不能发、发得动多少），并排三格本来就想表达一件事；
 * AI 用量和成本同理——同一批 trace 的两种看法（时间 vs 美元），拆两卡要看两遍模型名。
 */

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { api, pipelineApi, type PipelineItem } from '../../api'
import { aiRegistryApi } from '../../api/ai'
import { Card } from '../../components/ui'
import { Bar } from './shared'

export function HealthPanel() {
  const { t } = useTranslation()

  const { data: published = [] } = useQuery({
    queryKey: ['pipeline-stage', 'published'],
    queryFn: () => pipelineApi.items('published', 100),
  })
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
  const { data: failures = {} } = useQuery({
    queryKey: ['pipeline-failures'],
    queryFn: pipelineApi.failures,
    refetchInterval: 30_000,
  })
  const { data: trace = [] } = useQuery({
    queryKey: ['ai-trace-summary'],
    queryFn: () => aiRegistryApi.trace(undefined, 500),
  })
  const { data: cfg } = useQuery({
    queryKey: ['config'],
    queryFn: () =>
      api.get<{ ai_model_prices?: Record<string, { prompt?: number; completion?: number }> }>(
        '/api/config',
      ),
  })

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

  // AI 聚合：一次遍历同时得到「按模型耗时」和「按模型 token」，两张视图共用一份 byModel。
  const byModel = useMemo(() => {
    const map = new Map<string, { calls: number; ms: number; prompt: number; completion: number }>()
    for (const call of trace) {
      const key = call.model_key || 'unknown'
      const entry = map.get(key) ?? { calls: 0, ms: 0, prompt: 0, completion: 0 }
      entry.calls += 1
      entry.ms += call.duration_ms ?? 0
      entry.prompt += call.prompt_tokens ?? 0
      entry.completion += call.completion_tokens ?? 0
      map.set(key, entry)
    }
    return [...map.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 8)
  }, [trace])
  const maxMs = Math.max(...byModel.map(([, v]) => v.ms), 1)

  // 成本估算（v0.5 E）：tokens × 单价（美元/百万）；单价缺失的模型不算钱，只算用量。
  const costTotal = useMemo(() => {
    const prices = cfg?.ai_model_prices ?? {}
    let total = 0
    for (const [model, v] of byModel) {
      const price = prices[model]
      if (!price) continue
      total +=
        (v.prompt / 1_000_000) * (price.prompt ?? 0) +
        (v.completion / 1_000_000) * (price.completion ?? 0)
    }
    return total
  }, [byModel, cfg])
  const pricedCount = byModel.filter(([m]) => cfg?.ai_model_prices?.[m]).length

  const today = queueView?.today

  return (
    <div className="flex flex-col gap-4">
      {/* 发布：通道就绪 / 今日产能 / 队列深度——同两个端点的三面，一张卡三格 */}
      <Card className="p-4">
        <h2 className="mb-3 text-sm font-semibold text-text-primary">{t('dashboard.publishHealth')}</h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div>
            <h3 className="mb-2 text-[11px] font-medium text-text-secondary">{t('dashboard.publishChannel')}</h3>
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
                  <p className="pt-1 text-[10px] leading-relaxed text-warning">{t('dashboard.noopWarning')}</p>
                )}
              </dl>
            ) : (
              <p className="text-[11px] text-text-disabled">{t('common.loading')}</p>
            )}
          </div>

          <div>
            <h3 className="mb-2 text-[11px] font-medium text-text-secondary">{t('dashboard.autoPublish')}</h3>
            {today ? (
              <>
                <div className="flex items-baseline justify-between text-[11px]">
                  <span className="text-text-disabled">{t('dashboard.todayCapacity')}</span>
                  <span className="font-mono text-text-secondary">
                    {today.auto_published} / {today.daily_limit}
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2">
                  <div
                    className={`h-full transition-all ${
                      today.auto_enabled
                        ? today.auto_published >= today.daily_limit
                          ? 'bg-error/70'
                          : 'bg-primary'
                        : 'bg-text-disabled/40'
                    }`}
                    style={{
                      width: `${Math.min(
                        100,
                        Math.round((today.auto_published / Math.max(1, today.daily_limit)) * 100),
                      )}%`,
                    }}
                  />
                </div>
                <p className="mt-1.5 text-[10px] text-text-disabled">
                  {today.auto_enabled ? t('dashboard.autoPublishOn') : t('dashboard.autoPublishOff')}
                </p>
              </>
            ) : (
              <p className="text-[11px] text-text-disabled">{t('common.loading')}</p>
            )}
          </div>

          <div>
            <h3 className="mb-2 text-[11px] font-medium text-text-secondary">{t('dashboard.queueDepth')}</h3>
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
          </div>
        </div>
      </Card>

      {/* AI 用量与成本：同一批 trace 的两种看法，并排不分行 */}
      <Card className="p-4">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold text-text-primary">{t('dashboard.usageCost')}</h2>
          <span className="font-mono text-[11px] text-text-secondary">
            {t('dashboard.costTotal')} ${costTotal.toFixed(4)}
          </span>
        </div>
        {byModel.length === 0 ? (
          <p className="text-xs text-text-disabled">{t('dashboard.usageEmpty')}</p>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              {byModel.map(([model, v]) => (
                <Bar key={model} label={model} value={v.ms} max={maxMs} tone="bg-primary/60" />
              ))}
              <p className="pt-1 text-[10px] text-text-disabled">
                {t('dashboard.usageHint', { calls: trace.length })}
              </p>
            </div>
            <div className="flex flex-col gap-1.5 md:border-l md:border-border/60 md:pl-4">
              {pricedCount === 0 ? (
                <p className="text-xs text-text-disabled">{t('dashboard.costEmpty')}</p>
              ) : (
                byModel
                  .filter(([model]) => cfg?.ai_model_prices?.[model])
                  .map(([model, v]) => {
                    const price = cfg?.ai_model_prices?.[model]
                    const usd =
                      (v.prompt / 1_000_000) * (price?.prompt ?? 0) +
                      (v.completion / 1_000_000) * (price?.completion ?? 0)
                    return (
                      <div key={model} className="flex items-center justify-between text-xs">
                        <span className="min-w-0 truncate font-mono text-text-secondary">{model}</span>
                        <span className="shrink-0 text-text-disabled">
                          {(v.prompt + v.completion).toLocaleString()} tok · ${usd.toFixed(4)}
                        </span>
                      </div>
                    )
                  })
              )}
              <p className="pt-1 text-[10px] text-text-disabled">{t('dashboard.costHint')}</p>
            </div>
          </div>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {/* 发布统计（近 30 天）：发出去几条、分布在哪、平均多少播放 */}
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
                  <span className="ml-1 text-[10px] text-text-disabled">
                    {t('dashboard.withStatsCount', { n: withStats.length })}
                  </span>
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
                    <span
                      key={target}
                      className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-text-secondary"
                    >
                      {target} × {n}
                    </span>
                  ))}
                </dd>
              )}
            </div>
          </dl>
        </Card>

        {/* 失败分布（v0.12）：按错误类聚合 */}
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
      </div>
    </div>
  )
}
