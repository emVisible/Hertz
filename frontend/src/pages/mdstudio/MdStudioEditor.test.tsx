/**
 * 编辑器 ↔ 画布 联动的页面级判据（Phase 4）。
 *
 * 这份只测**接线**（谁把什么喂给谁）：纯换算在 outline.test.ts，编辑器自身在
 * MarkdownEditor.test.tsx。这里守的是三条一接就断的线：
 * ①光标移动 → 画布上那块被高亮；
 * ②大纲点一项 → 编辑器光标跳到那一行；
 * ③画布点段落 → 编辑器选中那一段（旧的块编辑框仍然在）。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  }
})

// 与 MdStudioPage.test.tsx 同一套 mock 形状：Proxy + 顶层 let（vi.mock 会被提升，
// 里面不能用顶层 const——那是本文件第一版栽的坑）
const calls: Record<string, unknown[][]> = {}

vi.mock('../../api', () => ({
  layoutApi: new Proxy(
    {},
    {
      get:
        (_target, prop: string) =>
        (...args: unknown[]) => {
          ;(calls[prop] ??= []).push(args)
          if (prop === 'list') return Promise.resolve([DOC])
          if (prop === 'get') return Promise.resolve(DOC)
          if (prop === 'update') return Promise.resolve(DOC)
          return Promise.resolve({ ok: true })
        },
    },
  ),
  docsApi: { list: () => Promise.resolve([]) },
}))

import { MdStudioPage } from './MdStudioPage'

const DOC: Record<string, unknown> = {
  id: 'l1',
  title: '测试稿',
  platform: 'wechat',
  theme_id: 'modi',
  source_md: ['# 总标题', '', '## 甲节', '', '正文甲。', '', '## 乙节', '', '正文乙。'].join('\n'),
  overrides: {},
  footer: '',
  qr: null,
  breaks: [],
  created_at: '2026-10-13T00:00:00Z',
  updated_at: '2026-10-13T00:00:00Z',
}

const wrapper = ({ children }: { children: ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

const renderPage = () => render(<MdStudioPage />, { wrapper })

/** 等画布渲出块：大纲与联动都挂在 debounce 后的 renderDraft 上（150ms），不等就会看到空态 */
async function waitCanvas() {
  await waitFor(() => expect(document.querySelector('[data-mdcore-block]')).toBeTruthy(), { timeout: 3000 })
}

beforeEach(() => {
  for (const key of Object.keys(calls)) delete calls[key]
  localStorage.clear()
})

describe('编辑器接入', () => {
  it('源文区渲染的是 CodeMirror，不再是裸 textarea', async () => {
    renderPage()
    await waitFor(() => expect(document.querySelector('.cm-editor')).toBeTruthy())
    expect(document.querySelector('.cm-content')?.textContent).toContain('总标题')
  })

  it('大纲列出 H1~H3，点一项跳到那一行', async () => {
    const user = userEvent.setup()
    renderPage()
    await waitFor(() => expect(screen.getByTestId('mdstudio-outline')).toBeTruthy())

    await waitCanvas()
    // 「## 甲节」在第 2 行（0 基）：#0 / ##2 / ##6
    expect(screen.getByTestId('outline-item-2')).toBeTruthy()
    await user.click(screen.getByTestId('outline-item-2'))
    // 点完之后光标落在那一行：大纲里该项变成当前项
    await waitFor(() => expect(screen.getByTestId('outline-item-2').getAttribute('aria-current')).toBe('true'))
  })

  it('大纲可收起（长稿里要把它让给正文）', async () => {
    const user = userEvent.setup()
    renderPage()
    await waitCanvas()
    await user.click(screen.getByTestId('mdstudio-outline-toggle'))
    expect(screen.queryByTestId('mdstudio-outline')).toBeNull()
    await user.click(screen.getByTestId('mdstudio-outline-toggle'))
    expect(screen.getByTestId('mdstudio-outline')).toBeTruthy()
  })
})

describe('分栏可拖', () => {
  it('拖动改变左栏宽度', async () => {
    renderPage()
    await waitCanvas()
    const before = (screen.getByTestId('mdstudio-left') as HTMLElement).style.width
    const sep = screen.getByTestId('mdstudio-split')

    fireEvent.pointerDown(sep, { clientX: 320, clientY: 0 })
    fireEvent.pointerMove(window, { clientX: 400, clientY: 0 })
    await waitFor(() => expect((screen.getByTestId('mdstudio-left') as HTMLElement).style.width).not.toBe(before))
    expect((screen.getByTestId('mdstudio-left') as HTMLElement).style.width).toBe('400px')

    fireEvent.pointerUp(window, { clientX: 400, clientY: 0 })
    expect(localStorage.getItem('hertz.mdstudio.leftWidth')).toBe('400')
  })

  it('宽度有下限：拖到最左不会把列表压没', async () => {
    renderPage()
    await waitCanvas()
    const sep = screen.getByTestId('mdstudio-split')
    fireEvent.pointerDown(sep, { clientX: 320, clientY: 0 })
    fireEvent.pointerMove(window, { clientX: 0, clientY: 0 })
    expect((screen.getByTestId('mdstudio-left') as HTMLElement).style.width).toBe('240px')
    fireEvent.pointerUp(window, { clientX: 0, clientY: 0 })
  })

  it('键盘也能调（拖不到的地方要留一条路）', async () => {
    const user = userEvent.setup()
    renderPage()
    const aside = await waitFor(() => screen.getByTestId('mdstudio-left'))
    const before = Number.parseInt((aside as HTMLElement).style.width, 10)
    screen.getByTestId('mdstudio-split').focus()
    await user.keyboard('{ArrowLeft}')
    await waitFor(() =>
      expect(Number.parseInt((screen.getByTestId('mdstudio-left') as HTMLElement).style.width, 10)).toBeLessThan(before),
    )
  })
})

describe('编辑器 → 画布', () => {
  /**
   * 走的是"大纲点击"这条路而不是键盘：jsdom 里 CM 的选区来自 DOM Selection，
   * fireEvent.keyDown 改不动它；而 jumpToLine 是走 CM 自己的 dispatch，会真的
   * 触发 updateListener → onCursorLine → 画布高亮。用能触发的那条路测，
   * 比造一个测不动的假键盘诚实。
   */
  it('点大纲把光标送到那一行，画布跟着高亮那一块', async () => {
    const user = userEvent.setup()
    renderPage()
    await waitCanvas()
    await user.click(screen.getByTestId('outline-item-2')) // 「## 甲节」

    await waitFor(
      () => {
        const focused = document.querySelector('[data-mdcore-block][data-mdcore-focus="true"]')
        expect(focused).toBeTruthy()
        // 第 2 行是「## 甲节」——IR 块序：0 总标题 / 1 甲节 / 2 正文甲 / 3 乙节 / 4 正文乙
        expect(focused?.getAttribute('data-mdcore-block')).toBe('1')
      },
      { timeout: 2000 },
    )
  })

  it('再点另一项，高亮跟着换块（联动不是摆设）', async () => {
    const user = userEvent.setup()
    renderPage()
    await waitCanvas()
    await user.click(screen.getByTestId('outline-item-6')) // 「## 乙节」
    await waitFor(
      () => {
        const focused = document.querySelector('[data-mdcore-block][data-mdcore-focus="true"]')
        expect(focused?.getAttribute('data-mdcore-block')).toBe('3')
      },
      { timeout: 2000 },
    )
  })

  it('高亮同一时刻只落在一块上（不能整篇都亮）', async () => {
    const user = userEvent.setup()
    renderPage()
    await waitCanvas()
    await user.click(screen.getByTestId('outline-item-2'))
    await waitFor(() =>
      expect(document.querySelectorAll('[data-mdcore-block][data-mdcore-focus="true"]').length).toBeGreaterThan(0),
    )
    expect(document.querySelectorAll('[data-mdcore-block][data-mdcore-focus="true"]').length).toBe(1)
  })
})
