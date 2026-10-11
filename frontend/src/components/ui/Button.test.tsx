import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Icon } from '../ui'
import { Button } from './Button'

describe('Button 的 loading 语义', () => {
  it('loading 时用转圈**替换**图标槽，不与静态图标并排出现', () => {
    // 并排出现时那个不动的图标会被读成第二个状态：「在忙」+「另一个东西」。
    const { container } = render(
      <Button loading icon={<Icon name="downloads" size={12} />}>
        下载中
      </Button>,
    )
    expect(container.querySelector('svg')).toBeNull()
    const spinner = container.querySelector('[aria-busy="true"]')
    expect(spinner).not.toBeNull()
    expect(spinner?.querySelector('span')).toHaveClass('rounded-full')
  })

  it('转圈是圆的（rounded-full）且继承按钮文字色', () => {
    // 早先按钮内联的那份漏了 rounded-full，转的是方框，读起来像「图标歪了」。
    const { container } = render(<Button loading>处理中</Button>)
    const ring = container.querySelector('[aria-busy="true"] span')
    expect(ring).toHaveClass('rounded-full')
    expect(ring).toHaveClass('border-current/30', 'border-t-current')
  })

  it('非 loading 时渲染图标槽且不打 aria-busy', () => {
    const { container } = render(<Button icon={<Icon name="play" size={12} />}>制作</Button>)
    expect(container.querySelector('svg')).not.toBeNull()
    expect(container.querySelector('[aria-busy="true"]')).toBeNull()
    expect(screen.getByRole('button')).toBeEnabled()
  })

  it('loading 禁用按钮；独立的 disabled 不改 busy 语义', () => {
    const { rerender } = render(<Button loading>下载中</Button>)
    expect(screen.getByRole('button')).toBeDisabled()
    rerender(<Button disabled>下载</Button>)
    expect(screen.getByRole('button')).toBeDisabled()
    expect(screen.getByRole('button')).not.toHaveAttribute('aria-busy')
  })

  it('sm 与 md 的转圈直径不同（跟着按钮高度走）', () => {
    const sm = render(<Button size="sm" loading>x</Button>)
    const smRing = sm.container.querySelector('[aria-busy="true"] span') as HTMLElement
    expect(smRing.style.width).toBe('12px')
    const md = render(<Button size="md" loading>y</Button>)
    const mdRing = md.container.querySelector('[aria-busy="true"] span') as HTMLElement
    expect(mdRing.style.width).toBe('14px')
  })

  it('按钮内的转圈是装饰性的（不重复播报 Loading）', () => {
    const { container } = render(<Button loading>下载中</Button>)
    const ring = container.querySelector('[aria-busy="true"] span')
    expect(ring).toHaveAttribute('aria-hidden', 'true')
    expect(ring).not.toHaveAttribute('role', 'status')
  })
})
