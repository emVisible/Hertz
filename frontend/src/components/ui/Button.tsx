import type { ButtonHTMLAttributes, ReactNode } from 'react'

import { Spinner } from './Spinner'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  /**
   * 进行中：按钮禁用，且图标槽换成转圈。
   *
   * **必须按动作判定**（`busy?.action === 'download'`），不能写 `!!busy`：
   * 一个条目同时挂着「下载中」和「评分」两个按钮，`!!busy` 会让两个都转起来、
   * 两边文案都变成自己的忙态文案——用户点下载，评分按钮却显示「评分中」在转圈
   * （本仓真发生过）。同一个条目上「谁在忙」只有一个，所以谓词必须带动作名。
   * 禁用仍然用 `!!busy`：同一条目并发两个写操作会互相踩。
   */
  loading?: boolean
  /**
   * 图标槽。`loading` 时**替换**成 `Spinner`（不是叠加）——静态图标与转圈并排
   * 出现时，转圈说的是「在忙」，旁边那个不动的东西会被读成第二个状态。
   * assets 页手写过的 `{busy ? <Spinner/> : <Icon/>}` 由此收口到这里。
   */
  icon?: ReactNode
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

/** 转圈直径跟着按钮高度走（sm 28px / md 36px），不写死一套尺寸。 */
const SPINNER_SIZE: Record<ButtonSize, number> = { sm: 12, md: 14 }

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled,
  icon,
  children,
  className = '',
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`inline-flex select-none items-center justify-center rounded-md font-medium
        transition-[box-shadow,background-color,color,border-color] duration-150
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40
        disabled:cursor-not-allowed ${VARIANT_CLASS[variant]} ${SIZE_CLASS[size]} ${className}`}
      {...rest}
    >
      {loading ? <Spinner size={SPINNER_SIZE[size]} tone="current" label={null} /> : icon}
      {children}
    </button>
  )
}

