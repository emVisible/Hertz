/** 看板 ·「供给」那一节（v0.34 D-218：从独立栏目并进「今天」页）。
 *
 * 里面只剩两件**读数**：手里还有多少货（趋势 + 各阶段存量），以及该捞什么口味
 * （频道洞察）。原先这块下面的「待处理」两列已经搬去流水线——它是动作，不是读数，
 * 而用户明确说过它不该在看板里（D-218）。
 *
 * 只读；要动手的地方在流水线（预处理 / 审核 / 已过审待发），所以这里只留一个跳过去的入口。
 * 查询键与旧版逐字一致（`pipeline-counts` / `pipeline-trends` / `channel-insight`），
 * 同键同缓存，拆并栏目不多开一路轮询。
 */

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'

import { api, pipelineApi } from '../../api'
import { Card, Icon } from '../../components/ui'
import { Bar, STAGES, TrendChart, type ChannelInsight } from './shared'

export function SupplySection() {
  const { t } = useTranslation()
  const navigate = useNavigate()

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
  const { data: insight, refetch: refetchInsight } = useQuery({
    queryKey: ['channel-insight'],
    queryFn: () => api.get<ChannelInsight | null>('/api/ai/insights'),
    refetchInterval: 300_000,
  })
  // 供给告警（v0.34 D-223）：后端早就算好了四档水位，界面上却一直没接出来——
  // 「采集停了六周」这件事当时就躺在这条查询里，没人看得见。
  const { data: supply } = useQuery({
    queryKey: ['pipeline-supply'],
    queryFn: pipelineApi.supply,
    refetchInterval: 30_000,
  })
  const warnings = supply?.warnings ?? []

  const maxCount = useMemo(() => Math.max(...STAGES.map((s) => counts[s.key] ?? 0), 1), [counts])

  return (
    <div className="flex flex-col gap-4">
      {/* 趋势 + 漏斗合成一张：两张图回答的是同一个问题（这批货有多少、动得快不快），
          分成两卡只是把一次扫视拆成两次。 */}
      <Card className="p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-text-primary">{t('dashboard.supplyWater')}</h2>
          <button
            type="button"
            onClick={() => navigate('/execution?mode=pipeline')}
            className="text-[11px] text-text-secondary transition-colors hover:text-primary"
          >
            {t('dashboard.goPipeline')} ↗
          </button>
        </div>
        {warnings.length > 0 && (
          <div
            role="alert"
            className="mb-3 flex flex-col gap-1 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-2"
          >
            {warnings.map((w) => (
              <p key={w} className="flex items-start gap-1.5 text-[11px] leading-relaxed text-warning">
                <Icon name="alert" size={12} className="mt-0.5 shrink-0" />
                {t(`console.supply.${w}`, w)}
              </p>
            ))}
          </div>
        )}
        <TrendChart data={trends} />
        <div className="mt-4 flex flex-col gap-1.5 border-t border-border/60 pt-3">
          {STAGES.map((s) => (
            <Bar key={s.key} label={t(s.labelKey)} value={counts[s.key] ?? 0} max={maxCount} tone={s.tone} />
          ))}
        </div>
      </Card>

      {/* 频道洞察（v0.19 数据飞轮）：AI 基于发布表现总结受众偏好——它指导的是「捞哪批」，
          所以跟供给水位放在一起。 */}
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
