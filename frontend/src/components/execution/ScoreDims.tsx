/** 评分维度可视化（审核/预处理卡片共用，AXIOM §1.2 单一真相源）。
 *  v0.2.6：彩色水平条形图——每维度一行固定色（8 色板），条长 = 相对强度，
 *  有限空间内客观可比。只渲染数值字段（LLM 返回混入的 script_meta/subtitle
 *  等 object/boolean 不再平铺成「裹脚布」）。 */

/** 已知维度展示顺序；每维度固定颜色（0-10 分尺度下色相有区分度） */
const KNOWN_DIMS: Array<[string, string]> = [
  ['entertainment', '#f472b6'], // 粉
  ['novelty', '#a78bfa'], // 紫
  ['completion', '#60a5fa'], // 蓝
  ['cultural_fit', '#34d399'], // 绿
  ['short_form', '#fbbf24'], // 黄
  ['visual_punch', '#fb7185'], // 玫红
  ['emotion', '#22d3ee'], // 青
  ['safety', '#f87171'], // 红
]
const FALLBACK_COLOR = '#a1a1aa'

export function ScoreDims({ dims }: { dims: Record<string, unknown> | null | undefined }) {
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
        return (
          <div key={k} className="flex items-center gap-2">
            <span className="w-20 shrink-0 truncate text-[10px] text-text-disabled">{k}</span>
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
