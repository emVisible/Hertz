import type { ReactNode } from 'react'

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'error' | 'primary'

export interface BadgeProps {
  tone?: BadgeTone
  children: ReactNode
}

const TONE_CLASS: Record<BadgeTone, string> = {
  neutral: 'bg-surface-2 text-text-secondary',
  success: 'bg-success/15 text-success',
  warning: 'bg-warning/15 text-warning',
  error: 'bg-error/15 text-error',
  primary: 'bg-primary/15 text-primary',
}

export function Badge({ tone = 'neutral', children }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${TONE_CLASS[tone]}`}
    >
      {children}
    </span>
  )
}
