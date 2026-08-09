import type { ReactNode } from 'react'

import { Icon, type IconName } from './Icon'

export interface EmptyStateProps {
  icon?: IconName
  title: string
  description?: string
  action?: ReactNode
}

export function EmptyState({ icon = 'library', title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
      <span className="mb-1 flex h-12 w-12 items-center justify-center rounded-xl border border-border bg-surface-2 text-text-disabled shadow-sm">
        <Icon name={icon} size={22} />
      </span>
      <p className="text-sm font-medium text-text-primary">{title}</p>
      {description && <p className="max-w-xs text-xs text-text-secondary">{description}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  )
}
