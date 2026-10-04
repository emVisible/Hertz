/** 看板 · 供给栏（v0.34 重设计）：手里还有多少货、动得快不快、该捞什么口味。
 *
 * 这一栏只做两件事：给水位/趋势的**读数**，以及把「待审 / 待发布」两列摆出来能直接动手。
 * 动作仍复用流水线那两张卡（`ItemCard` 一处分派），所以全仓只有一套过审/发布入口——
 * 这两列也是界面上唯一的单条发布入口（原「发布」tab 已并进看板，spec §4.4b），
 * 因此这里不能压成纯文字清单：那样 approved 条目就再也发不出去了。
 *
 * 查询键与原来那张长页**逐字一致**（`pipeline-counts` / `pipeline-trends` /
 * `channel-insight` / `pipeline-board`）——同键同缓存，拆分栏目不会多出一套轮询。
 */

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'

import { api, pipelineApi, type BoardColumn, type BoardResponse, type PipelineItem } from '../../api'
import { Badge, Button, Card, Icon } from '../../components/ui'
import { wallDay } from '../../core/boardWindow'
import type { BoardActions } from './boardActions'
import { Bar, ItemCard, STAGES, TrendChart, type ChannelInsight } from './shared'
import type { FocusPatch } from './TodayPanel'

interface SupplyPanelProps {
  p: BoardActions
  onFocus: (item: PipelineItem, patch: FocusPatch) => void
}

export function SupplyPanel({ p, onFocus }: SupplyPanelProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const day = wallDay()

  const { data: counts = {} } = useQuery({
    queryKey: ['pipeline-counts'],
    queryFn: pipelineApi.counts,
    refetchInterval: 15_000,
  })
  const { data: trends = [] } = useQuery({
    queryKey: ['pipeline-trends'],
    queryFn: () => pipelineApi.trends(30),
    refetchInterval: 60_000,
  })
  const { data: board } = useQuery({
    queryKey: ['pipeline-board', day],
    queryFn: () => pipelineApi.board(day),
  })
  const { data: insight, refetch: refetchInsight } = useQuery({
    queryKey: ['channel-insight'],
    queryFn: () => api.get<ChannelInsight | null>('/api/ai/insights'),
    refetchInterval: 300_000,
  })

  const maxCount = useMemo(() => Math.max(...STAGES.map((s) => counts[s.key] ?? 0), 1), [counts])

  return (
    <div className="flex flex-col gap-4">
      {/* 趋势 + 漏斗合成一张：两张图回答的是同一个问题（这批货有多少、动得快不快），
          分成两卡只是把一次扫视拆成两次。 */}
      <Card className="p-4">
        <h2 className="mb-3 text-sm font-semibold text-text-primary">{t('dashboard.supplyWater')}</h2>
        <TrendChart data={trends} />
        <div className="mt-4 flex flex-col gap-1.5 border-t border-border/60 pt-3">
          {STAGES.map((s) => (
            <Bar key={s.key} label={t(s.labelKey)} value={counts[s.key] ?? 0} max={maxCount} tone={s.tone} />
          ))}
        </div>
      </Card>

      {/* 待处理：待审 + 待发布并排（原「审核」「发布」两个视图的同一批条目，
          在看板里本来就是一件事的两半——捞进今日之后它们会改出现在「今天」栏）。 */}
      <Card className="p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-text-primary">{t('dashboard.awaiting')}</h2>
          <button
            type="button"
            onClick={() => navigate('/execution?mode=pipeline')}
            className="text-[11px] text-text-secondary transition-colors hover:text-primary"
          >
            {t('dashboard.goPipeline')} ↗
          </button>
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <SupplyColumn column="review" labelKey="console.boardColReview" p={p} board={board} onFocus={onFocus} />
          <SupplyColumn
            column="ready_to_publish"
            labelKey="console.boardColReady"
            p={p}
            board={board}
            onFocus={onFocus}
            footnote={t('console.publishHint')}
          />
        </div>
      </Card>

      {/* 频道洞察（v0.19 数据飞轮）：AI 基于发布表现总结受众偏好——它指导的是「捞哪批」，
          所以归在供给栏，不在健康栏。 */}
      {insight && (
        <Card className="p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="flex items-center gap-1.5 text-xs font-medium text-text-primary">
              <Icon name="wand" size={13} className="text-primary" />
              {t('dashboard.insightTitle')}
              {insight.generated_at && <span className="text-[10px] text-text-disabled">{insight.generated_at}</span>}
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
              <li key={v} className="text-warning/90">
                · {t('dashboard.insightAvoid')}: {v}
              </li>
            ))}
            {insight.notes && <li className="text-text-primary">· {insight.notes}</li>}
          </ul>
        </Card>
      )}
    </div>
  )
}

/** 一列待处理：计数用截断**前**的 `counts`，列表用截断后的 `columns`，两者不一样时要说清。 */
function SupplyColumn({
  column,
  labelKey,
  p,
  board,
  onFocus,
  footnote,
}: {
  column: BoardColumn
  labelKey: string
  p: BoardActions
  board?: BoardResponse
  onFocus: (item: PipelineItem, patch: FocusPatch) => void
  footnote?: string
}) {
  const { t } = useTranslation()
  const rows = board?.columns[column] ?? []
  const total = board?.counts[column] ?? 0

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-medium text-text-primary">{t(labelKey)}</h3>
        <Badge tone="neutral">{total}</Badge>
        {total > rows.length && (
          <span className="text-[10px] text-text-disabled">
            {t('console.boardTruncated', { shown: rows.length, total })}
          </span>
        )}
      </div>
      {rows.length === 0 && <p className="py-2 text-xs text-text-disabled">{t('console.boardColumnEmpty')}</p>}
      <div className="flex flex-col gap-2">
        {rows.map((item) => (
          <div key={item.id} className="flex flex-col gap-1">
            <div className="flex justify-end px-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onFocus(item, { focus_date: wallDay() })}
                title={t('console.boardPickHint')}
              >
                {t('console.boardPickToday')}
              </Button>
            </div>
            <ItemCard item={item} p={p} />
          </div>
        ))}
      </div>
      {footnote && <p className="mt-2 border-t border-border/60 pt-2 text-[10px] text-text-disabled">{footnote}</p>}
    </div>
  )
}
