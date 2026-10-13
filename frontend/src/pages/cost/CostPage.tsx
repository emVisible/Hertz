import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

import type React from 'react'

import { api } from '../../api'
import {
  Badge,
  Button,
  Card,
  CopyButton,
  Icon,
  QueryErrorState,
  Select,
} from '../../components/ui'

/** 成本报表（v0.14）：金额查询时按当前单价动态计算（D-176）。 */
interface CostReport {
  currency: { code: string; symbol: string; rate: number }
  summary: {
    total_calls: number
    billed_calls: number
    total_cost: number
    coverage: number
    prompt_tokens: number
    completion_tokens: number
    days: number
  }
  by_domain: Array<{
    domain: string
    calls: number
    prompt_tokens: number
    completion_tokens: number
    cost: number | null
  }>
  by_model: Array<{
    model_key: string
    calls: number
    prompt_tokens: number
    completion_tokens: number
    cost: number | null
  }>
  daily: Array<{ date: string; cost: number }>
  missing_prices: string[]
  /** 月度预算阶梯（v0.17）：budget=0（未配置）时为 null */
  budget: {
    monthly: number
    used: number
    ratio: number
    level: 'ok' | 'warning' | 'critical' | 'exceeded'
    month_start: string
  } | null
  /** 条目 ROI（v0.15）：每条视频的 AI 总成本 × 播放表现 */
  items: Array<{
    item_id: string
    title: string
    published_at: string | null
    views: number | null
    calls: number
    ai_cost: number | null
    /** v0.38：本地模型 ai_cost 恒为 0，时长才是本地用户真实的成本维度 */
    ai_duration_ms: number
    asset_path: string | null
  }>
  calls: Array<{
    id: string
    created_at: string | null
    domain: string
    caller: string
    provider_key: string
    model_key: string
    operation: string
    prompt_tokens: number | null
    completion_tokens: number | null
    duration_ms: number
    status: string
    error: string
    cost: number | null
    task_id: string | null
    /** 溯源（v0.14.1）：task_id="item:<uuid>" 解析出的条目关联 */
    item: { id: string; title: string; asset_path: string | null } | null
  }>
}

const RANGES = [7, 30, 90] as const

function fmtCost(symbol: string, v: number | null | undefined): string {
  if (v == null) return '—'
  return `${symbol}${v.toFixed(4).replace(/\.?0+$/, '')}`
}

/** 毫秒时长 → `1m 03s`。本地推理的真实成本是「等了多久」，所以它必须可读。 */
function fmtDuration(ms: number): string {
  const total = Math.round(ms / 1000)
  if (total < 60) return `${total}s`
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`
}

function fmtTokens(n: number | null | undefined): string {
  if (n == null) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

export function CostPage() {
  const { t } = useTranslation()
  const [days, setDays] = useState<number>(30)
  const [domainFilter, setDomainFilter] = useState<string>('')
  const [offset, setOffset] = useState<number>(0)
  const PAGE_SIZE = 50

  const { data, isLoading, error, refetch, isFetching } = useQuery<CostReport>({
    queryKey: ['ai-costs', days, domainFilter, offset],
    queryFn: () =>
      api.get<CostReport>(
        `/api/ai/costs?days=${days}&limit=${PAGE_SIZE}&offset=${offset}${domainFilter ? `&domain=${encodeURIComponent(domainFilter)}` : ''}`,
      ),
    refetchInterval: 60_000,
  })

  const symbol = data?.currency.symbol ?? ''
  const totalCalls = data?.summary.total_calls ?? 0
  const page = Math.floor(offset / PAGE_SIZE) + 1
  const totalPages = Math.max(1, Math.ceil(totalCalls / PAGE_SIZE))
  const avgDaily =
    data && data.daily.length > 0
      ? data.summary.total_cost / data.daily.length
      : null

  const pickDomain = (d: string) => {
    setDomainFilter((v) => (v === d ? '' : d))
    setOffset(0)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      {/* 头部：标题 + 区间切换 + 单价管理入口 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-center gap-2 text-base font-semibold text-text-primary">
          <Icon name="tag" size={17} className="text-primary" />
          {t('cost.title')}
          {data && (
            <Badge tone="neutral">
              {data.currency.code}
              {data.currency.rate !== 1 ? ` @${data.currency.rate}` : ''}
            </Badge>
          )}
        </h1>
        <div className="flex items-center gap-2">
          <Select
            aria-label={t('cost.range')}
            value={String(days)}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
              setDays(Number(e.target.value))
            }
            options={RANGES.map((r) => ({
              value: String(r),
              label: t('cost.days', { n: r }),
            }))}
            className="w-28"
          />
          <Link to="/config?section=ai">
            <Button size="sm" variant="secondary">
              <Icon name="pen" size={12} />
              {t('cost.managePrices')}
            </Button>
          </Link>
        </div>
      </div>

      {error ? (
        <QueryErrorState
          message={error instanceof Error ? error.message : String(error)}
          onRetry={() => void refetch()}
        />
      ) : isLoading || !data ? (
        <p className="py-10 text-center text-sm text-text-disabled">{t('common.loading')}</p>
      ) : (
        <>
          {/* 月度预算阶梯（v0.17）：warning/critical/exceeded 三档提示，不阻断 */}
          {data.budget && data.budget.level !== 'ok' && (
            <Card
              className={
                data.budget.level === 'exceeded'
                  ? 'border-error/50 bg-error/5'
                  : data.budget.level === 'critical'
                    ? 'border-warning/60 bg-warning/10'
                    : 'border-warning/40 bg-warning/5'
              }
            >
              <p
                className={`text-xs leading-relaxed ${
                  data.budget.level === 'exceeded' ? 'text-error' : 'text-warning'
                }`}
              >
                {t(`cost.budget.${data.budget.level}`, {
                  used: fmtCost(symbol, data.budget.used),
                  budget: fmtCost(symbol, data.budget.monthly),
                })}
              </p>
            </Card>
          )}

          {/* 未配价警告 */}
          {data.missing_prices.length > 0 && (
            <Card className="border-warning/40 bg-warning/5">
              <p className="text-xs leading-relaxed text-warning">
                {t('cost.missingPrices', { models: data.missing_prices.join(', ') })}
              </p>
            </Card>
          )}

          {/* ===== 块一：看板（概览 + 环节分布 + 趋势 + 模型） ===== */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Card>
              <p className="text-[11px] uppercase tracking-wide text-text-disabled">
                {t('cost.totalSpend')}
              </p>
              <p className="mt-1 font-mono text-xl font-semibold text-text-primary">
                {fmtCost(symbol, data.summary.total_cost)}
              </p>
              {avgDaily != null && (
                <p className="mt-0.5 text-[11px] text-text-disabled">
                  {t('cost.avgDaily', { v: fmtCost(symbol, avgDaily) })}
                </p>
              )}
            </Card>
            <Card>
              <p className="text-[11px] uppercase tracking-wide text-text-disabled">
                {t('cost.totalCalls')}
              </p>
              <p className="mt-1 font-mono text-xl font-semibold text-text-primary">
                {data.summary.total_calls}
              </p>
            </Card>
            <Card>
              <p className="text-[11px] uppercase tracking-wide text-text-disabled">
                {t('cost.promptTokens')}
              </p>
              <p className="mt-1 font-mono text-xl font-semibold text-text-primary">
                {fmtTokens(data.summary.prompt_tokens)}
              </p>
            </Card>
            <Card>
              <p className="text-[11px] uppercase tracking-wide text-text-disabled">
                {t('cost.completionTokens')}
              </p>
              <p className="mt-1 font-mono text-xl font-semibold text-text-primary">
                {fmtTokens(data.summary.completion_tokens)}
              </p>
            </Card>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {/* 环节分布（核心视图：点击筛选历史） */}
            <Card>
              <h2 className="mb-3 flex items-center gap-2 text-sm font-medium text-text-primary">
                <Icon name="layers" size={14} className="text-primary" />
                {t('cost.byDomain')}
              </h2>
              {data.by_domain.length === 0 ? (
                <p className="py-6 text-center text-xs text-text-disabled">{t('cost.empty')}</p>
              ) : (
                <ul className="space-y-2.5">
                  {data.by_domain.map((d) => (
                    <li key={d.domain}>
                      <button
                        type="button"
                        onClick={() => pickDomain(d.domain)}
                        className={`w-full rounded-md border px-3 py-2 text-left transition-colors ${
                          domainFilter === d.domain
                            ? 'border-primary/50 bg-primary/5'
                            : 'border-transparent hover:bg-surface-2/50'
                        }`}
                      >
                        <div className="flex items-center gap-2 text-xs">
                          <span className="font-medium text-text-primary">
                            {t(`cost.domain.${d.domain}`, { defaultValue: d.domain })}
                          </span>
                          <Badge tone={d.cost == null ? 'warning' : 'neutral'}>
                            {d.cost == null ? t('cost.unpriced') : fmtCost(symbol, d.cost)}
                          </Badge>
                          <span className="ml-auto text-text-disabled">
                            {t('cost.callsN', { n: d.calls })} · ↑{fmtTokens(d.prompt_tokens)} ↓{fmtTokens(d.completion_tokens)}
                          </span>
                        </div>
                        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2">
                          <div
                            className={`h-full rounded-full ${d.cost == null ? 'bg-warning/50' : 'bg-primary'}`}
                            style={{
                              width: `${Math.round(((d.cost ?? 0) / Math.max(0.000001, ...(data.by_domain.map((x) => x.cost ?? 0)))) * 100)}%`,
                            }}
                          />
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            {/* 右列：日趋势 + 模型分布 */}
            <div className="flex min-w-0 flex-col gap-4">
              <Card>
                <h2 className="mb-3 flex items-center gap-2 text-sm font-medium text-text-primary">
                  <Icon name="clock" size={14} className="text-primary" />
                  {t('cost.dailyTrend')}
                </h2>
                {data.daily.length === 0 ? (
                  <p className="py-6 text-center text-xs text-text-disabled">{t('cost.empty')}</p>
                ) : (
                  <div className="flex items-end gap-1">
                    {data.daily.map((d) => (
                      <div key={d.date} className="flex min-w-6 flex-1 flex-col items-center gap-1">
                        <div
                          title={`${d.date} · ${fmtCost(symbol, d.cost)}`}
                          className="w-full rounded-t-sm bg-primary/60"
                          style={{
                            height: `${Math.max(3, Math.round((d.cost / Math.max(0.000001, ...data.daily.map((x) => x.cost))) * 48))}px`,
                          }}
                        />
                        <span className="text-[9px] text-text-disabled">{d.date.slice(5)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </Card>

              <Card>
                <h2 className="mb-3 flex items-center gap-2 text-sm font-medium text-text-primary">
                  <Icon name="box" size={14} className="text-primary" />
                  {t('cost.byModel')}
                </h2>
                {data.by_model.length === 0 ? (
                  <p className="py-6 text-center text-xs text-text-disabled">{t('cost.empty')}</p>
                ) : (
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-border text-[10px] uppercase tracking-wide text-text-disabled">
                        <th className="py-1.5 pr-3">{t('cost.colModel')}</th>
                        <th className="py-1.5 pr-3 text-right">{t('cost.totalCalls')}</th>
                        <th className="py-1.5 pr-3 text-right">tokens</th>
                        <th className="py-1.5 text-right">{t('cost.colCost')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.by_model.map((m) => (
                        <tr key={m.model_key} className="border-b border-border/40 last:border-0">
                          <td className="py-1.5 pr-3 font-mono text-[11px]">{m.model_key}</td>
                          <td className="py-1.5 pr-3 text-right font-mono">{m.calls}</td>
                          <td className="py-1.5 pr-3 text-right font-mono text-text-secondary">
                            ↑{fmtTokens(m.prompt_tokens)} ↓{fmtTokens(m.completion_tokens)}
                          </td>
                          <td className="py-1.5 text-right font-mono">{fmtCost(symbol, m.cost)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>
            </div>
          </div>

          {/* ===== 块二：条目 ROI（v0.15 单位经济） ===== */}
          {data.items.length > 0 && (
            <Card>
              <h2 className="mb-3 flex items-center gap-2 text-sm font-medium text-text-primary">
                <Icon name="whisper" size={14} className="text-primary" />
                {t('cost.byItem')}
              </h2>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-border text-[10px] uppercase tracking-wide text-text-disabled">
                      <th className="py-1.5 pr-3">{t('console.titleLabel')}</th>
                      <th className="py-1.5 pr-3">{t('cost.colPublished')}</th>
                      <th className="py-1.5 pr-3 text-right">{t('cost.colViews')}</th>
                      <th className="py-1.5 pr-3 text-right">{t('cost.colCalls')}</th>
                      <th className="py-1.5 pr-3 text-right">{t('cost.aiCostOfItem')}</th>
                      <th className="py-1.5 pr-3 text-right" title={t('cost.aiTimeHint')}>
                        {t('cost.aiTime')}
                      </th>
                      <th className="py-1.5 pr-3 text-right">{t('cost.costPerK')}</th>
                      <th className="py-1.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((it) => {
                      const perK =
                        it.ai_cost != null && it.views && it.views > 0
                          ? (it.ai_cost / it.views) * 1000
                          : null
                      return (
                        <tr key={it.item_id} className="border-b border-border/40 last:border-0">
                          <td className="max-w-64 truncate py-1.5 pr-3" title={it.title}>
                            {it.title || '—'}
                          </td>
                          <td className="py-1.5 pr-3 font-mono text-[11px] text-text-secondary">
                            {it.published_at ? new Date(it.published_at).toLocaleDateString() : '—'}
                          </td>
                          <td className="py-1.5 pr-3 text-right font-mono">
                            {it.views != null ? fmtTokens(it.views) : '—'}
                          </td>
                          <td className="py-1.5 pr-3 text-right font-mono text-text-secondary">{it.calls}</td>
                          <td className="py-1.5 pr-3 text-right font-mono">{fmtCost(symbol, it.ai_cost)}</td>
                          <td className="py-1.5 pr-3 text-right font-mono text-text-secondary">
                            {/* 本地推理时上面那列恒为 0；这一列才是「这条等了多久」 */}
                            {it.ai_duration_ms > 0 ? fmtDuration(it.ai_duration_ms) : '—'}
                          </td>
                          <td className="py-1.5 pr-3 text-right font-mono">{perK != null ? fmtCost(symbol, perK) : '—'}</td>
                          <td className="py-1.5">
                            {it.asset_path && (
                              <Link
                                to={`/assets?path=${encodeURIComponent(it.asset_path)}`}
                                title={t('cost.viewAsset')}
                                className="flex h-6 w-6 items-center justify-center rounded-sm text-text-secondary transition-colors hover:bg-surface-2 hover:text-primary"
                              >
                                <Icon name="folder" size={13} />
                              </Link>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {/* ===== 块三：执行历史（溯源 + hover 操作 + 分页） ===== */}
          <Card>
            <h2 className="mb-3 flex flex-wrap items-center gap-2 text-sm font-medium text-text-primary">
              <Icon name="list" size={14} className="text-primary" />
              {t('cost.history')}
              {domainFilter && (
                <Badge tone="primary">
                  {t(`cost.domain.${domainFilter}`, { defaultValue: domainFilter })}
                  <button
                    type="button"
                    onClick={() => {
                      setDomainFilter('')
                      setOffset(0)
                    }}
                    className="ml-1"
                  >
                    ×
                  </button>
                </Badge>
              )}
              {totalCalls > PAGE_SIZE && (
                <span className="ml-auto flex items-center gap-2 text-[11px] text-text-disabled">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={offset === 0 || isFetching}
                    onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                  >
                    ‹
                  </Button>
                  {page} / {totalPages}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={offset + PAGE_SIZE >= totalCalls || isFetching}
                    onClick={() => setOffset(offset + PAGE_SIZE)}
                  >
                    ›
                  </Button>
                </span>
              )}
            </h2>
            {data.calls.length === 0 ? (
              <p className="py-6 text-center text-xs text-text-disabled">{t('cost.empty')}</p>
            ) : (
              <div className="max-h-[480px] overflow-y-auto overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 z-10 bg-surface-1">
                    <tr className="border-b border-border text-[10px] uppercase tracking-wide text-text-disabled">
                      <th className="py-1.5 pr-3">{t('cost.colTime')}</th>
                      <th className="py-1.5 pr-3">{t('cost.colDomain')}</th>
                      <th className="py-1.5 pr-3">{t('cost.colModel')}</th>
                      <th className="py-1.5 pr-3 text-right">↑</th>
                      <th className="py-1.5 pr-3 text-right">↓</th>
                      <th className="py-1.5 pr-3 text-right">{t('cost.colDuration')}</th>
                      <th className="py-1.5 pr-3 text-right">{t('cost.colCost')}</th>
                      <th className="py-1.5 pr-2">{t('cost.colStatus')}</th>
                      <th className="py-1.5" aria-label={t('cost.colActions')} />
                    </tr>
                  </thead>
                  <tbody>
                    {data.calls.map((c) => (
                      <tr
                        key={c.id}
                        className="group border-b border-border/40 transition-colors last:border-0 hover:bg-surface-2/40"
                      >
                        <td className="py-1.5 pr-3 font-mono text-[11px] text-text-secondary">
                          {c.created_at ? new Date(c.created_at).toLocaleString() : '—'}
                        </td>
                        <td className="py-1.5 pr-3">
                          {t(`cost.domain.${c.domain}`, { defaultValue: c.domain })}
                        </td>
                        <td className="py-1.5 pr-3 font-mono text-[11px]">{c.model_key}</td>
                        <td className="py-1.5 pr-3 text-right font-mono text-text-secondary">
                          {fmtTokens(c.prompt_tokens)}
                        </td>
                        <td className="py-1.5 pr-3 text-right font-mono text-text-secondary">
                          {fmtTokens(c.completion_tokens)}
                        </td>
                        <td className="py-1.5 pr-3 text-right font-mono text-text-secondary">
                          {c.duration_ms >= 1000
                            ? `${(c.duration_ms / 1000).toFixed(1)}s`
                            : `${c.duration_ms}ms`}
                        </td>
                        <td className="py-1.5 pr-3 text-right font-mono">{fmtCost(symbol, c.cost)}</td>
                        <td className="py-1.5 pr-2">
                          {c.status === 'ok' ? (
                            <span className="text-success">✓</span>
                          ) : (
                            <span className="text-error" title={c.error}>
                              ✗
                            </span>
                          )}
                        </td>
                        {/* hover 操作（v0.14.1）：溯源跳转 + 复制模型名 */}
                        <td className="py-1.5">
                          <span className="flex items-center justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                            {c.item?.asset_path && (
                              <Link
                                to={`/assets?path=${encodeURIComponent(c.item.asset_path)}`}
                                title={`${t('cost.viewAsset')}: ${c.item.title}`}
                                className="flex h-6 w-6 items-center justify-center rounded-sm text-text-secondary transition-colors hover:bg-surface-2 hover:text-primary"
                              >
                                <Icon name="folder" size={13} />
                              </Link>
                            )}
                            <CopyButton text={c.model_key} className="relative" />
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <p className="pb-2 text-[11px] leading-relaxed text-text-disabled">
            {t('cost.scopeNote')}
          </p>
        </>
      )}
    </div>
  )
}
