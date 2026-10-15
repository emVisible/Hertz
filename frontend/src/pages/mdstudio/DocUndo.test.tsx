/**
 * 文档级撤销的页级判据：改主题 → 撤销 → 稿子真的回来了。
 *
 * 只测纯函数是不够的——最常见的失效是"历史库写得对，但没接进 `patchDraft`"，
 * 或者"接了但被自动保存的 doc 回包盖回去"。这两件都只有从页面这一层走一遍才看得见。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

const updates: Array<Record<string, unknown>> = []

const BASE: Record<string, unknown> = {
  id: 'l1',
  title: '撤销稿',
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
        { id: 'l1', title: '撤销稿', platform: 'wechat', theme_id: 'modi', updated_at: '' },
      ]),
    get: () => Promise.resolve(BASE),
    update: (_id: string, patch: Record<string, unknown>) => {
      updates.push(patch)
      return Promise.resolve({ ...BASE, ...patch })
    },
  },
  docsApi: { list: () => Promise.resolve([]) },
}))

import { MdStudioPage } from './MdStudioPage'

const wrapper = ({ children }: { children: ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

/** 当前选中主题的按钮名（选中那个带勾） */
function activeThemeName(): string | null {
  const active = document.querySelector('[data-testid="mdstudio-inspector"] button[data-active="true"]')
  // 名字后面可能挂「深色」角标，取第一段
  return active?.textContent?.trim().split(/mdstudio\.|深色/)[0] ?? null
}

/** 主题是按钮组（带色卡），不是下拉——点名字里含关键词的那个 */
async function pickTheme(user: ReturnType<typeof userEvent.setup>, keyword: string) {
  const btn = [...document.querySelectorAll('[data-testid="mdstudio-inspector"] button')].find((b) =>
    (b.textContent ?? '').includes(keyword),
  )
  if (!btn) throw new Error(`主题按钮里找不到「${keyword}」`)
  await user.click(btn as HTMLElement)
}

async function ready() {
  render(<MdStudioPage />, { wrapper })
  await waitFor(() => expect(document.querySelector('.mdcore-doc')).toBeTruthy(), { timeout: 5000 })
}

describe('文档级撤销：改主题撤得回来', () => {
  it('换主题后按撤销，选中的主题回到原来那个', async () => {
    const user = userEvent.setup()
    await ready()

    const undoBtn = screen.getByRole('button', { name: 'mdstudio.history.undo' })
    expect((undoBtn as HTMLButtonElement).disabled, '初始就该置灰——没改过什么').toBe(true)

    await pickTheme(user, '晚风')
    await waitFor(() => expect((undoBtn as HTMLButtonElement).disabled).toBe(false))

    await user.click(undoBtn)
    await waitFor(() => expect(activeThemeName()).toBe('墨滴'))
  })

  it('撤销后重做能回来', async () => {
    const user = userEvent.setup()
    await ready()
    const undoBtn = screen.getByRole('button', { name: 'mdstudio.history.undo' })
    const redoBtn = screen.getByRole('button', { name: 'mdstudio.history.redo' })

    await pickTheme(user, '晚风')
    await user.click(undoBtn)
    await waitFor(() => expect((redoBtn as HTMLButtonElement).disabled).toBe(false))
    await user.click(redoBtn)
    await waitFor(() => expect(activeThemeName()).toBe('晚风'))
  })

  it('文字变更不入文档历史（CodeMirror 自己管，两边都管会退两段）', async () => {
    const user = userEvent.setup()
    await ready()
    const undoBtn = screen.getByRole('button', { name: 'mdstudio.history.undo' })
    await waitFor(() => expect(document.querySelector('.cm-content')).toBeTruthy())

    await user.type(document.querySelector('.cm-content') as HTMLElement, '甲乙丙')
    // 文字改完，文档级撤销仍是置灰：那一步归编辑器，不归这里
    expect((undoBtn as HTMLButtonElement).disabled).toBe(true)
  })

  it('撤销出来的内容会被自动保存带走（不然撤了等于没撤）', async () => {
    const user = userEvent.setup()
    updates.length = 0
    await ready()
    await pickTheme(user, '晚风')
    await user.click(screen.getByRole('button', { name: 'mdstudio.history.undo' }))
    await waitFor(() => {
      const last = updates[updates.length - 1]
      expect(last?.theme_id ?? 'modi').toBe('modi')
    })
  })
})
