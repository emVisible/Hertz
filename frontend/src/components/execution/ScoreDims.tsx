/** 评分维度 chips（审核/预处理卡片共用，AXIOM §1.2 单一真相源）。 */
export function ScoreDims({ dims }: { dims: Record<string, number> | null | undefined }) {
  if (!dims) return null
  const entries = Object.entries(dims)
  if (entries.length === 0) return null
  return (
    <>
      {entries.map(([k, v]) => (
        <span
          key={k}
          className="border border-border px-1.5 py-0.5 font-mono text-[10px] leading-none text-text-secondary"
          title={`${k}: ${v}`}
        >
          {k} {typeof v === 'number' ? v.toFixed(1) : String(v)}
        </span>
      ))}
    </>
  )
}
