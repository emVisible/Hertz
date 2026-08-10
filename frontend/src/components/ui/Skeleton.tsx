/** Skeleton 骨架屏（v0.4 E1）：列表/网格加载占位，prefers-reduced-motion 降级。 */

export interface SkeletonProps {
  /** 行数（列表场景） */
  rows?: number
  /** 卡片数（网格场景） */
  count?: number
  /** 每行高度 */
  height?: number
  className?: string
}

function SkeletonLine({ height = 12, className = '' }: { height?: number; className?: string }) {
  return (
    <div
      aria-hidden
      style={{ height }}
      className={`animate-pulse rounded bg-surface-2 ${className}`}
    />
  )
}

/** 行式骨架（标题 + 副行 + 右侧占位，仿列表卡片）。 */
export function SkeletonList({ rows = 6, height = 48, className = '' }: SkeletonProps) {
  return (
    <div role="status" aria-label="Loading" className={`flex flex-col gap-2 p-3 ${className}`}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} style={{ height }} className="flex items-center gap-3 rounded border border-border/40 px-3">
          <SkeletonLine height={height - 24} className="w-24 shrink-0" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <SkeletonLine height={10} className="w-2/3" />
            <SkeletonLine height={8} className="w-1/3" />
          </div>
        </div>
      ))}
    </div>
  )
}

/** 卡片式骨架（网格场景）。 */
export function SkeletonCard({ count = 6, className = '' }: SkeletonProps) {
  return (
    <div role="status" aria-label="Loading" className={`grid grid-cols-2 gap-3 p-3 md:grid-cols-3 lg:grid-cols-4 ${className}`}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex flex-col gap-1.5 rounded-lg border border-border/40 p-2">
          <SkeletonLine height={80} />
          <SkeletonLine height={10} className="w-3/4" />
          <SkeletonLine height={8} className="w-1/2" />
        </div>
      ))}
    </div>
  )
}
