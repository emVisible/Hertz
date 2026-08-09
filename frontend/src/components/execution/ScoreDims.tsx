/** 评分维度展示（审核/预处理卡片共用，AXIOM §1.2 单一真相源）。
 *  v0.2.6：只渲染数值维度（LLM 返回里混入的 script_meta/subtitle 等
 *  object/boolean 字段不再平铺成「裹脚布」）；两列迷你网格 + 相对强度条。 */

/** 展示顺序（已知维度），其余数值字段按出现顺序追加 */
const KNOWN_DIMS = [
  'entertainment',
  'novelty',
  'completion',
  'cultural_fit',
  'short_form',
  'visual_punch',
  'emotion',
  'safety',
] as const

export function ScoreDims({ dims }: { dims: Record<string, unknown> | null | undefined }) {
  if (!dims) return null
  const numeric = Object.entries(dims).filter(([, v]) => typeof v === 'number')
  if (numeric.length === 0) return null

  const ordered = [...numeric].sort((a, b) => {
    const ia = KNOWN_DIMS.indexOf(a[0] as (typeof KNOWN_DIMS)[number])
    const ib = KNOWN_DIMS.indexOf(b[0] as (typeof KNOWN_DIMS)[number])
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
  })

  return (
    <div className="mt-1.5 grid grid-cols-4 gap-x-3 gap-y-1">
      {ordered.map(([k, v]) => {
        const val = v as number
        const pct = Math.min(100, Math.max(0, val * 10))
        return (
          <div key={k} className="flex items-center gap-1" title={`${k}: ${val.toFixed(1)}`}>
            <span className="w-0 flex-1 truncate text-[10px] text-text-disabled">{k}</span>
            <span className="font-mono text-[10px] text-text-secondary">{val.toFixed(1)}</span>
            <span className="h-1 w-6 shrink-0 overflow-hidden rounded-full bg-surface-2">
              <span
                className="block h-full rounded-full bg-text-disabled/60"
                style={{ width: `${pct}%` }}
              />
            </span>
          </div>
        )
      })}
    </div>
  )
}
