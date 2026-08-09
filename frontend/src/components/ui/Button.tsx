import type { ButtonHTMLAttributes, ReactNode } from 'react'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
  children: ReactNode
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary:
    'bg-primary text-on-primary shadow-sm hover:bg-primary-hover hover:shadow-md disabled:bg-text-disabled/40 disabled:text-text-primary/60 disabled:shadow-none',
  secondary:
    'bg-surface-2 text-text-primary hover:bg-surface-1 border border-border hover:border-text-disabled/50',
  ghost: 'bg-transparent text-text-secondary hover:bg-surface-2 hover:text-text-primary',
  danger: 'bg-error/10 text-error hover:bg-error/20',
}

const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: 'h-7 px-3 text-xs gap-1.5',
  md: 'h-9 px-4 text-sm gap-2',
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled,
  children,
  className = '',
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      className={`inline-flex select-none items-center justify-center rounded-md font-medium
        transition-[box-shadow,background-color,color,border-color] duration-150
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40
        disabled:cursor-not-allowed ${VARIANT_CLASS[variant]} ${SIZE_CLASS[size]} ${className}`}
      {...rest}
    >
      {loading && (
        <span className="h-3 w-3 animate-spin  border-2 border-current border-t-transparent" />
      )}
      {children}
    </button>
  )
}
