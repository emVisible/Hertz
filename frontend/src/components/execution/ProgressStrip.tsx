import { Progress } from '../ui'

export interface ProgressStripProps {
  label: string
  index: number
  total: number
  /** 0-100 真实完成度（completed / total） */
  value: number
}

/** 运行进度条：当前阶段 + 真实完成度 + 序号。 */
export function ProgressStrip({ label, index, total, value }: ProgressStripProps) {
  return (
    <div className="shrink-0 border border-border bg-surface-1 px-4 py-2.5">
      <div className="mb-1.5 flex items-center justify-between text-xs">
        <span className="font-medium text-primary">{label}</span>
        <span className="text-text-disabled">
          {index} / {total}
        </span>
      </div>
      <Progress value={value} className="h-1" />
    </div>
  )
}
