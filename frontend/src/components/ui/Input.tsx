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
    <div className="flex flex-col gap-1.5">
      {label && (
        <label htmlFor={inputId} className="text-xs font-medium text-text-secondary">
          {label}
        </label>
      )}
      <input
        id={inputId}
        ref={ref}
        className={`h-9  border border-border bg-surface-2 px-3 text-sm text-text-primary
          placeholder:text-text-disabled transition-colors duration-150
          focus:border-primary focus:bg-surface-1 focus:outline-none focus:ring-2 focus:ring-primary/30
          ${error ? 'border-error focus:border-error focus:ring-error/30' : ''} ${className}`}
        {...rest}
      />
      {error && <span className="text-xs text-error">{error}</span>}
    </div>
  )
})
