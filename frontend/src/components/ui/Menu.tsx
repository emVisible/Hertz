import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon, type IconName } from './Icon'

export interface MenuItem {
  label: string
  icon?: IconName
  onClick: () => void
  disabled?: boolean
  /** 当前态高亮（右侧 ✓） */
  active?: boolean
  danger?: boolean
  title?: string
}

/** 下拉菜单（AXIOM 四部：渐进披露——变体动作收纳进菜单，主按钮保持单一）。
 *  触发区由调用方提供（支持分裂按钮）；Esc / 外部点击关闭；focus-within 保持打开。 */
export function Menu({
  trigger,
  items,
  align = 'right',
}: {
  trigger: (open: boolean) => ReactNode
  items: (MenuItem | 'divider')[]
  align?: 'left' | 'right'
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onPointerDown(e: PointerEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  return (
    <div
      ref={ref}
      className="relative"
      onKeyDown={(e) => {
        if (e.key === 'Escape') setOpen(false)
      }}
    >
      <div onClick={() => setOpen((v) => !v)}>{trigger(open)}</div>
      {open && (
        <div
          className={`absolute z-30 mt-1 min-w-44 rounded-md border border-border bg-surface-1 py-1 shadow-lg ${
            align === 'right' ? 'right-0' : 'left-0'
          }`}
        >
          {items.map((item, i) =>
            item === 'divider' ? (
              <div key={`d-${i}`} className="my-1 border-t border-border/60" />
            ) : (
              <button
                key={item.label}
                type="button"
                disabled={item.disabled}
                title={item.title}
                onClick={() => {
                  setOpen(false)
                  item.onClick()
                }}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
                  item.danger
                    ? 'text-error hover:bg-surface-2'
                    : item.active
                      ? 'text-primary hover:bg-surface-2'
                      : 'text-text-primary hover:bg-surface-2'
                } disabled:cursor-not-allowed disabled:opacity-40`}
              >
                {item.icon && <Icon name={item.icon} size={12} className="shrink-0 text-text-secondary" />}
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.active && <Icon name="check" size={12} className="shrink-0" />}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  )
}