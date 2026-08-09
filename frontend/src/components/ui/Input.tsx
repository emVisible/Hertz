import type { InputHTMLAttributes } from 'react'
import { forwardRef } from 'react'

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, error, className = '', id, ...rest },
  ref,
) {
  const inputId = id ?? label
  return (
    // className 作用于外层容器：grid/flex 布局中以容器为尺寸基准伸展，
    // 内部控件固定 w-full——修复同一行 input/select 长短不一（AXIOM §27）
    <div className={`flex flex-col gap-1.5 ${className}`}>
      {label && (
        <label htmlFor={inputId} className="text-xs font-medium text-text-secondary">
          {label}
        </label>
      )}
      <input
        id={inputId}
        ref={ref}
        className={`h-9 w-full border border-border bg-surface-2 px-3 text-sm text-text-primary
          placeholder:text-text-disabled transition-[border-color,background-color] duration-150
          hover:border-text-disabled/50
          focus:border-primary focus:bg-surface-1 focus:outline-none focus:ring-2 focus:ring-primary/30
          ${error ? 'border-error focus:border-error focus:ring-error/30' : ''}`}
        {...rest}
      />
      {error && <span className="text-xs text-error">{error}</span>}
    </div>
  )
})
