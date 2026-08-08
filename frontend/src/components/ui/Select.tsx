import type { SelectHTMLAttributes } from 'react'

export interface SelectOption {
  value: string
  label: string
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string
  options: SelectOption[]
}

export function Select({ label, options, className = '', id, ...rest }: SelectProps) {
  const selectId = id ?? label
  return (
    // className 作用于外层容器（同 Input 约定，AXIOM §27 对齐）：flex/grid
    // 布局以容器为尺寸基准，内部控件固定 w-full
    <div className={`flex flex-col gap-1.5 ${className}`}>
      {label && (
        <label htmlFor={selectId} className="text-xs font-medium text-text-secondary">
          {label}
        </label>
      )}
      <div className="relative">
        <select
          id={selectId}
          className={`h-9 w-full appearance-none  border border-border bg-surface-2 px-3 pr-8 text-sm text-text-primary
            transition-colors duration-150 focus:border-primary focus:bg-surface-1 focus:outline-none focus:ring-2 focus:ring-primary/30`}
          {...rest}
        >
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-text-disabled">
          ▾
        </span>
      </div>
    </div>
  )
}
