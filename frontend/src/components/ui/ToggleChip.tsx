import type { ReactNode } from 'react'

/** 可切换 pill 按钮（v0.8 提取）：三态配色 primary/warning，全项目 chips 统一。 */
export function ToggleChip({
  active,
  onClick,
  title,
  tone = 'primary',
  children,
}: {
  active: boolean
  onClick: () => void
  title?: string
  tone?: 'primary' | 'warning'
  children: ReactNode
}) {
  const activeClass =
    tone === 'warning'
      ? 'border-warning/50 bg-warning/15 font-medium text-warning'
      : 'border-primary/40 bg-primary/15 font-medium text-primary'
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`shrink-0 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
        active ? activeClass : 'border-transparent text-text-disabled hover:border-border hover:text-text-secondary'
      }`}
    >
      {children}
    </button>
  )
}
