/** 看板页共享件：条目卡片分派 + 阶段清单 + 两个纯 CSS 图（AXIOM 零依赖：不引图表库）。
 *
 * 从 `DashboardPage` 抽出来是因为这一页拆成了三个子栏目（今天 / 供给 / 成本与健康），
 * 而 `Bar`（漏斗水位、AI 用量）和条目卡片分派都被两个栏目共用——留在其中一个文件里，
 * 另一个就得跨页去捡私有组件；放这儿，两边都只依赖这份签名。
 */

import { useTranslation } from 'react-i18next'

import type { PipelineItem } from '../../api'
import { Badge } from '../../components/ui'
import { AuditCard, PublishCard, StageItemRow } from '../../components/execution'
import type { BoardActions } from './boardActions'

/** 一条条目该用哪张卡（v0.34 重设计抽成一处）。
 *
 * 抽出来的理由：今天栏和供给栏都要画同一批条目，而「approved 能发、queued 能审、
 * 其余只列出来」这条规则如果两边各写一遍，改状态时就会漂成两套动作（这个仓库里
 * 最贵的就是同一个判断有两个作者）。动作本身仍复用流水线那两个卡片组件，
 * 所以全仓只有一套发布/过审入口。
 */
export function ItemCard({ item, p }: { item: PipelineItem; p: BoardActions }) {
  if (item.status === 'approved') {
    return (
      <PublishCard
        item={item}
        onPublish={(i, selfmade, target, now) => p.publishItem(i, selfmade, target, now)}
        onSaveMeta={(i, meta) => void p.saveMeta(i, meta)}
        onRequeue={(i) => void p.act(i, 'requeue')}
        onRandomCover={(i) => void p.randomCover(i)}
      />
    )
  }
  if (item.status === 'queued') {
    return (
      <AuditCard
        item={item}
        onApprove={(i) => void p.act(i, 'approve')}
        onReject={(i) => void p.act(i, 'reject')}
        onUploadCover={(i, file) => void p.uploadCover(i, file)}
        onRandomCover={(i) => void p.randomCover(i)}
        onBackToPrep={(i) => void p.backToPrep(i)}
      />
    )
  }
  // 其余状态（在制 downloaded/scored 等）只列出来：下载/制作的入口在流水线，
  // 在这里抄一份按钮就会变成第二个写点。
  return <StageItemRow item={item} badge={<Badge tone="neutral">{item.status}</Badge>} />
}

/** 频道洞察（v0.19 数据飞轮）：`/api/ai/insights` 的快照形状。
 *  原来只在 `DashboardPage` 里本地声明，搬到供给栏后放这份共享模块，
 *  免得查询的泛型参数和渲染用的类型分处两页。 */
export interface ChannelInsight {
  audience_preferences?: string[]
  hook_styles?: string[]
  avoid_topics?: string[]
  notes?: string
  generated_at?: string
  source_count?: number
}

export const STAGES: Array<{ key: string; labelKey: string; tone: string }> = [
  { key: 'discovered', labelKey: 'console.stageCollect', tone: 'bg-text-disabled/50' },
  { key: 'downloaded', labelKey: 'console.stagePreReview', tone: 'bg-primary/70' },
  { key: 'scored', labelKey: 'console.scored', tone: 'bg-primary/70' },
  { key: 'queued', labelKey: 'console.stageAudit', tone: 'bg-primary' },
  { key: 'approved', labelKey: 'console.stagePublish', tone: 'bg-emerald-400' },
  { key: 'published', labelKey: 'console.published', tone: 'bg-emerald-500' },
  { key: 'failed', labelKey: 'console.stageExceptions', tone: 'bg-error/70' },
]

/** 水平条形：`max` 由调用方给（一组里共享同一个分母才有可比性）。 */
export function Bar({ value, max, tone, label }: { value: number; max: number; tone: string; label: string }) {
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

/** 趋势直方图：采集/入库/发布 每日并排柱——数据稀疏时折线贴底不可见，
 *  柱状图保持直观（0 值不画柱，网格线兜底刻度）。 */
export function TrendChart({
  data,
}: {
  data: Array<{ date: string; collected: number; inserted: number; published: number }>
}) {
  const { t } = useTranslation()
  const W = 600
  const H = 170
  const PAD = 12
  const n = data.length
  const max = Math.max(
    ...data.map((d) => d.collected),
    ...data.map((d) => d.inserted),
    ...data.map((d) => d.published),
    1,
  )
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
          <line
            key={f}
            x1={PAD}
            x2={W - PAD}
            y1={PAD + (yMax - PAD) * f}
            y2={PAD + (yMax - PAD) * f}
            className="stroke-border/60"
            strokeWidth={0.5}
          />
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
            <text
              key={d.date}
              x={PAD + i * groupW + groupW / 2}
              y={H - 2}
              textAnchor="middle"
              className="fill-text-disabled"
              fontSize={8}
            >
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
