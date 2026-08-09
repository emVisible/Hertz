/** 评分维度可视化（审核/预处理卡片共用，AXIOM §1.2 单一真相源）。
 *  v0.2.7：维度名中英随界面语言（i18n）；低饱和色板（贴合单色简约设计，
 *  不刺眼）；条长 = 相对强度。只渲染数值字段（LLM 返回混入的 object/boolean
 *  不再平铺成「裹脚布」）。 */

import { useTranslation } from 'react-i18next'

/** 已知维度展示顺序；每维度固定低饱和色（色相有区分但不刺眼） */
const KNOWN_DIMS: Array<[string, string]> = [
  ['entertainment', '#94a3b8'], // 灰蓝
  ['novelty', '#a5a3c2'], // 灰紫
  ['completion', '#8fae9c'], // 灰绿
  ['cultural_fit', '#b8a878'], // 灰金
  ['short_form', '#a89494'], // 灰玫
  ['visual_punch', '#8fafb4'], // 灰青
  ['emotion', '#b39aaa'], // 灰粉
  ['safety', '#b08787'], // 灰红
]
const FALLBACK_COLOR = '#a1a1aa'

export function ScoreDims({ dims }: { dims: Record<string, unknown> | null | undefined }) {
  const { t } = useTranslation()
  if (!dims) return null
  const numeric = Object.entries(dims).filter(([, v]) => typeof v === 'number')
  if (numeric.length === 0) return null

  const ordered = [...numeric].sort((a, b) => {
    const ia = KNOWN_DIMS.findIndex(([k]) => k === a[0])
    const ib = KNOWN_DIMS.findIndex(([k]) => k === b[0])
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
  })

  return (
    <div className="mt-2 flex flex-col gap-1.5">
      {ordered.map(([k, v]) => {
        const val = v as number
        const pct = Math.min(100, Math.max(0, val * 10))
        const color = KNOWN_DIMS.find(([dk]) => dk === k)?.[1] ?? FALLBACK_COLOR
        const label = t(`console.dims.${k}`, k)
        return (
          <div key={k} className="flex items-center gap-2">
            <span className="w-20 shrink-0 truncate text-[10px] text-text-disabled">{label}</span>
            <span className="relative h-2 flex-1 overflow-hidden rounded-full bg-surface-2">
              {/* 条长动画（宽度过渡，§35 动效只作用于装饰层） */}
              <span
                className="block h-full rounded-full transition-[width] duration-300 ease-out"
                style={{ width: `${pct}%`, background: color }}
              />
            </span>
            <span className="w-7 shrink-0 text-right font-mono text-[10px] text-text-secondary">
              {val.toFixed(1)}
            </span>
          </div>
        )
      })}
    </div>
  )
}
