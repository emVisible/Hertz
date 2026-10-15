/**
 * 文档级撤销的键盘通道（W4 交互）。
 *
 * 上一轮把撤销/重做做成了按钮，**却没给快捷键**——于是它不算数：用户按 Cmd+Z
 * 是肌肉记忆，鼠标要挪到工具条再挪回来。
 *
 * 但直接绑全局 Cmd+Z 会和编辑器打架：CodeMirror 已经用 Cmd+Z 撤销**文字**，
 * 两边都管就会出现"按一次撤销，文字退了、样式也退了"——用户以为回到了一步，
 * 实际退了两步，而且其中一步在另一边看不见。
 *
 * 所以按**焦点作用域**分：
 * - 焦点在编辑器里 → Cmd+Z 归 CodeMirror（文字撤销），我们不插手；
 * - 焦点在编辑器外（画布/工具条/检查器）→ Cmd+Z 是文档级（主题/平台/字号…）。
 *
 * 重做两边都给（Cmd+Shift+Z），因为"重做"没有焦点歧义。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const BASE: Record<string, unknown> = {
  id: 'l1',
  title: '快捷键稿',
  platform: 'wechat',
  theme_id: 'modi',
  source_md: '# 标题\n\n正文。',
  overrides: {},
  cover: {},
  created_at: '2026-10-15T00:00:00Z',
  updated_at: '2026-10-15T00:00:00Z',
}

vi.mock('../../api', () => ({
  layoutApi: {
    list: () =>
      Promise.resolve([
        { id: 'l1', title: '快捷键稿', platform: 'wechat', theme_id: 'modi', updated_at: '' },
      ]),
    get: () => Promise.resolve(BASE),
    update: () => Promise.resolve(BASE),
  },
  docsApi: { list: () => Promise.resolve([]) },
}))

import { MdStudioPage } from './MdStudioPage'

const wrapper = ({ children }: { children: ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

function activeThemeName(): string | null {
  const active = document.querySelector(
    '[data-testid="mdstudio-inspector"] button[data-active="true"]',
  )
  return active?.textContent?.trim().split(/mdstudio\.|深色/)[0] ?? null
}

async function ready() {
  render(<MdStudioPage />, { wrapper })
  await waitFor(() => expect(document.querySelector('.mdcore-doc')).toBeTruthy(), { timeout: 5000 })
  await waitFor(() => expect(document.querySelector('.cm-content')).toBeTruthy(), { timeout: 5000 })
}

async function pickTheme(user: ReturnType<typeof userEvent.setup>, keyword: string) {
  const btn = [...document.querySelectorAll('[data-testid="mdstudio-inspector"] button')].find((b) =>
    (b.textContent ?? '').includes(keyword),
  )
  if (!btn) throw new Error(`主题按钮里找不到「${keyword}」`)
  await user.click(btn as HTMLElement)
}

beforeEach(() => {
  localStorage.clear()
})

describe('焦点在编辑器外：Cmd+Z 是文档级撤销', () => {
  it('按 Cmd+Z 退回主题', async () => {
    const user = userEvent.setup()
    await ready()
    await pickTheme(user, '晚风')
    await waitFor(() => expect(activeThemeName()).toBe('晚风'))

    // 焦点落在画布侧（不是编辑器）
    document.querySelector('[data-testid="mdstudio-canvas-mount"]')?.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true }),
    )
    await user.keyboard('{Meta>}z{/Meta}')
    await waitFor(() => expect(activeThemeName()).toBe('墨滴'))
  })

  it('Cmd+Shift+Z 重做回来', async () => {
    const user = userEvent.setup()
    await ready()
    await pickTheme(user, '晚风')
    document.querySelector('[data-testid="mdstudio-canvas-mount"]')?.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true }),
    )
    await user.keyboard('{Meta>}z{/Meta}')
    await waitFor(() => expect(activeThemeName()).toBe('墨滴'))
    await user.keyboard('{Meta>}{Shift>}z{/Shift}{/Meta}')
    await waitFor(() => expect(activeThemeName()).toBe('晚风'))
  })
})

describe('焦点在编辑器里：Cmd+Z 归 CodeMirror，我们不插手', () => {
  it('在编辑器里按 Cmd+Z 不动主题（否则一次撤销退了两步）', async () => {
    const user = userEvent.setup()
    await ready()
    await pickTheme(user, '晚风')
    await waitFor(() => expect(activeThemeName()).toBe('晚风'))

    const editor = document.querySelector('.cm-content') as HTMLElement
    await user.click(editor)
    await user.keyboard('{Meta>}z{/Meta}')
    // 主题**不该**被文档级撤销改掉——这一步归编辑器
    await new Promise((r) => setTimeout(r, 120))
    expect(activeThemeName()).toBe('晚风')
  })

  it('编辑器里的 Shift+Z 也不抢（否则"重做"在一处是文字、在另一处是样式）', async () => {
    const user = userEvent.setup()
    await ready()
    await pickTheme(user, '晚风')
    const editor = document.querySelector('.cm-content') as HTMLElement
    await user.click(editor)
    await user.keyboard('{Meta>}{Shift>}z{/Shift}{/Meta}')
    await new Promise((r) => setTimeout(r, 120))
    // 焦点在编辑器里时，整组 Cmd+Z 归 CodeMirror
    expect(activeThemeName()).toBe('晚风')
  })
})

describe('按钮仍然可用（快捷键是补充，不是替代）', () => {
  it('工具条上的撤销按钮照旧工作', async () => {
    const user = userEvent.setup()
    await ready()
    await pickTheme(user, '晚风')
    await user.click(screen.getByRole('button', { name: 'mdstudio.history.undo' }))
    await waitFor(() => expect(activeThemeName()).toBe('墨滴'))
  })
})
/**
 * 画布内编辑（W4）：块编辑器只有关按钮，没有键盘出路。
 *
 * `Esc` 是"取消这次编辑"的通用手势，`Cmd+Enter` 是"存下这次编辑"的通用手势——
 * 两条都没有，用户就只能用鼠标去够那两个小图标，而此刻**他的手还在键盘上**
 * （他刚点完画布上的段落，正是为了改那一段）。
 */
describe('块编辑的键盘出路', () => {
  async function openBlockEditor(user: ReturnType<typeof userEvent.setup>) {
    await ready()
    const para = document.querySelector('.mdcore-doc p') as HTMLElement
    await user.click(para)
    return screen.findByTestId('mdstudio-block-editor')
  }

  it('Esc 关掉块编辑器（不保存）', async () => {
    const user = userEvent.setup()
    await openBlockEditor(user)
    const editor = await screen.findByLabelText('mdstudio.edit.text')
    await user.clear(editor)
    await user.type(editor, '改坏了')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByTestId('mdstudio-block-editor')).toBeNull())
  })

  it('Cmd+Enter 保存并关掉（键盘一路走完，不用去够保存按钮）', async () => {
    const user = userEvent.setup()
    await openBlockEditor(user)
    const editor = await screen.findByLabelText('mdstudio.edit.text')
    await user.clear(editor)
    await user.type(editor, '改好了')
    await user.keyboard('{Meta>}{Enter}{/Meta}')
    await waitFor(() => expect(screen.queryByTestId('mdstudio-block-editor')).toBeNull())
    // 真的写回了 Markdown 源文
    await waitFor(() => expect(document.querySelector('.cm-content')?.textContent).toContain('改好了'))
  })

  it('编辑中按 Cmd+Z 仍然只撤文字，不触发文档级撤销', async () => {
    const user = userEvent.setup()
    await openBlockEditor(user)
    await pickTheme(user, '晚风')
    const editor = await screen.findByLabelText('mdstudio.edit.text')
    await user.click(editor)
    await user.keyboard('{Meta>}z{/Meta}')
    await new Promise((r) => setTimeout(r, 120))
    // 块编辑器不是 CodeMirror，所以焦点在它里面时文档级撤销**不该**触发
    expect(activeThemeName()).toBe('晚风')
  })
})
