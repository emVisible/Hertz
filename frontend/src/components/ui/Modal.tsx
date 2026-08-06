import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'

import { Icon } from './Icon'

export interface ModalProps {
  open: boolean
  title?: string
  onClose: () => void
  children: ReactNode
  width?: number
}

export function Modal({ open, title, onClose, children, width = 480 }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    // 利落入场：100ms 直线淡入 + 2px 上移，无回弹无 overshoot（AXIOM §6.1）。
    const panel = panelRef.current
    if (!panel || typeof panel.animate !== 'function') return
    panel.animate(
      [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }],
      { duration: 100, easing: 'ease-out' },
    )
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={panelRef}
        style={{ width }}
        className="max-h-[80vh] overflow-auto  border border-border bg-surface-1 p-5 shadow-2xl"
      >
        <div className="mb-4 flex items-center justify-between">
          {title && <h2 className="text-base font-semibold text-text-primary">{title}</h2>}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className=" p-1 text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
          >
            <Icon name="close" size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}
