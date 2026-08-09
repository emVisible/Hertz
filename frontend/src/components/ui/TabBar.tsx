import { Fragment, type ReactNode } from 'react'

export interface TabBarItem<T extends string> {
  id: T
  label: ReactNode
  count?: number
  icon?: ReactNode
  /** 渲染分隔线（v0.2.7）：把特殊 menu（如异常）与正常流程区分开 */
  dividerBefore?: boolean
}

/** 应用级 tab 栏（底部指示条语言，wave13 统一 L2/L3 导航）：
 *  role=tab + aria-selected + 底部主色指示条 + 可选计数/图标/分隔。 */
export function TabBar<T extends string>({
  items,
  active,
  onChange,
  className = '',
}: {
  items: TabBarItem<T>[]
  active: T
  onChange: (id: T) => void
  className?: string
}) {
  return (
    <div role="tablist" className={`flex shrink-0 items-center gap-1 overflow-x-auto ${className}`}>
      {items.map((it) => {
        const isActive = it.id === active
        return (
          <Fragment key={it.id}>
            {it.dividerBefore && <span className="mx-1.5 h-4 w-px shrink-0 bg-border" />}
            <button
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => onChange(it.id)}
              className={`flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-1.5 text-xs font-medium transition-colors ${
                isActive
                  ? 'border-primary text-text-primary'
                  : 'border-transparent text-text-secondary hover:bg-surface-2 hover:text-text-primary'
              }`}
            >
              {it.icon}
              {it.label}
              {it.count !== undefined && (
                <span
                  className={`font-mono text-[10px] ${isActive ? 'text-primary' : 'text-text-disabled'}`}
                >
                  {it.count}
                </span>
              )}
            </button>
          </Fragment>
        )
      })}
    </div>
  )
}
