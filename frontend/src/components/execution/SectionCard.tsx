import type { ReactNode } from 'react'

import { Card } from '../ui'

export interface SectionCardProps {
  title: ReactNode
  right?: ReactNode
  children: ReactNode
  className?: string
  padded?: boolean
}

/** 带标题卡片容器（替代各处重复的 Card + 标题行）。 */
export function SectionCard({ title, right, children, className = '', padded = false }: SectionCardProps) {
  return (
    <Card padded={padded} className={`flex min-h-0 flex-col ${className}`}>
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {right}
      </div>
      {children}
    </Card>
  )
}
