export interface SpinnerProps {
  size?: number
  /**
   * 取色：
   * - `primary`：主题强调色（默认）——独立成块的加载态（页面级、占位符）。
   * - `current`：继承当前文字色（`currentColor`）——**按钮内必须用这个**：
   *   primary 色的转圈落在 primary 按钮上与底色同色，等于没有转圈。
   */
  tone?: 'primary' | 'current'
  /**
   * 无障碍文案；传 `null` = 装饰性（`aria-hidden`）。
   *
   * 按钮内传 `null`：按钮文案已经会说「下载中 / 评分中」，再播报一次
   * Loading 是重复噪音（screen reader 会连着念两遍）。
   */
  label?: string | null
  className?: string
}

const TONE_CLASS = {
  primary: 'border-primary/25 border-t-primary',
  current: 'border-current/30 border-t-current',
} as const

/**
 * 加载指示器（唯一的转圈实现）。
 *
 * 为什么要收口成这一个组件：按钮曾经自己内联了一份 `border-2 animate-spin`，
 * 那份**漏了 `rounded-full`**——转的是个方框，不是圆，读起来像「图标歪了」
 * 而不是「在转」。assets 页又手写了第三种 `{busy ? <Spinner/> : <Icon/>}`。
 * 三份写法、两种形状，现在统一到这里：形状（圆）、取色、装饰性播报都只此一处。
 */
export function Spinner({ size = 20, tone = 'primary', label = 'Loading', className = '' }: SpinnerProps) {
  return (
    <span
      role={label ? 'status' : undefined}
      aria-label={label ?? undefined}
      aria-hidden={label === null ? true : undefined}
      style={{ width: size, height: size }}
      className={`inline-block shrink-0 animate-spin rounded-full border-2 border-solid ${TONE_CLASS[tone]} ${className}`}
    />
  )
}
