/** MD Studio 新增能力的**宿主接线**判据（P1-3 / P2-2 / P2-4 / P2-5）。
 *
 * 为什么组件测试之外还要这一层：组件测试全绿 ≠ 宿主接线对（handover §4 第 14 条）。
 * 这一轮三件事都容易"接了但没接上"：
 *  - Shiki 二次 pass 在**渲染之后**，画布与各导出路各调一次；
 *  - Mermaid 要在**分页之前**预渲染，而宿主有多条出口（画布 / 卡片 / 长图 / 批量）；
 *  - PDF 的页数组来自 paginate，不是拿长图冒充。
 *
 * 引擎替身走 mdcore 的注入通道（`setCodeHighlighter`）——
 * `vi.mock('@hertz/mdcore')` 拦不住页面内部的调用（workspace 源码包的身份问题）。
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { setCodeHighlighter } from '@hertz/mdcore'

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) }
})

const DOC = {
  id: 'w1',
  title: '接线稿',
  platform: 'wechat',
  theme_id: 'modi',
  source_md: '```ts\nconst a = 1\n```\n\n```mermaid\nflowchart TD\n A-->B\n```\n\n正文段落。',
  source_ref: null,
  overrides: {},
  cover: {},
  created_at: '2026-10-16T00:00:00Z',
  updated_at: '2026-10-16T00:00:00Z',
}

vi.mock('../../api', () => ({
  layoutApi: {
    list: () => Promise.resolve([{ id: DOC.id, title: DOC.title, platform: DOC.platform }]),
    get: () => Promise.resolve(DOC),
    create: () => Promise.resolve(DOC),
    update: () => Promise.resolve(DOC),
    remove: () => Promise.resolve({ ok: true }),
  },
  docsApi: { list: () => Promise.resolve([]) },
}))

import { MdStudioPage } from './MdStudioPage'

const wrapper = ({ children }: { children: ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

/** 等画布挂上并完成一次渲染 */
async function renderPage() {
  render(<MdStudioPage />, { wrapper })
  await waitFor(() => expect(screen.getByTestId('mdstudio-canvas-mount')).toBeInTheDocument())
}

beforeEach(() => {
  setCodeHighlighter(async () => null)
})

describe('Shiki 二次 pass 的宿主接线', () => {
  it('画布上的代码块被升级成 Shiki 产物（渲染之后原地替换）', async () => {
    setCodeHighlighter(async () => '<span data-shiki="1">shiki</span>')
    await renderPage()
    await waitFor(
      () => {
        expect(document.querySelector('.mdcore-code code [data-shiki]')).toBeTruthy()
      },
      { timeout: 3000 },
    )
  })

  it('替身返回 null 时画布保留原高亮产物（不空、不崩）', async () => {
    setCodeHighlighter(async () => null)
    await renderPage()
    await waitFor(() => {
      const code = document.querySelector('.mdcore-code code')
      expect(code?.textContent).toContain('const a = 1')
    })
  })

  it('替身抛错也不影响画布（保底高亮还在）', async () => {
    setCodeHighlighter(async () => {
      throw new Error('engine down')
    })
    await renderPage()
    await waitFor(() => {
      expect(document.querySelector('.mdcore-code code')?.textContent).toContain('const a = 1')
    })
  })
})

describe('Mermaid 的宿主接线（分页之前）', () => {
  it('画布上的 mermaid 块在 jsdom 里落回源码，而不是空白图框', async () => {
    await renderPage()
    await waitFor(() => {
      // jsdom 没有真实布局，mermaid 渲染必失败 → 契约是"源码可见"（横幅那条另有 mdcore 判据）
      const pres = Array.from(document.querySelectorAll('.mdcore-code pre'))
      expect(pres.some((p) => p.textContent?.includes('flowchart'))).toBe(true)
    })
  })
})

describe('PDF 导出接线', () => {
  it('右栏有 PDF 按钮（全平台通用，与长图并存）', async () => {
    await renderPage()
    expect(screen.getByRole('button', { name: 'mdstudio.export.pdf' })).toBeInTheDocument()
  })

  it('点 PDF 进入导出态（宿主确实派发了这个动作）', async () => {
    await renderPage()
    const button = screen.getByRole('button', { name: 'mdstudio.export.pdf' })
    await act(async () => {
      fireEvent.click(button)
    })
    // 导出中：按钮进入 loading 且禁用。**PDF 的字节与页数不在这里断言**——
    // jsdom 没有 canvas，截图引擎跑不起来，产物层判据在 mdcore 的 pdf.test.ts
    // （%PDF 字节头 + 页数守恒 + 真 jsPDF 组装）。
    await waitFor(() => expect(screen.getByRole('button', { name: 'mdstudio.export.pdf' })).toBeDisabled())
  })
})

describe('设计器导出 CSS 接线', () => {
  it('导出 CSS 把主题 CSS 写进剪贴板', async () => {
    const writeText = vi.fn(async (_text: string) => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await renderPage()
    fireEvent.click(screen.getByRole('button', { name: /mdstudio\.designer\.open/ }))
    await waitFor(() => expect(screen.getByTestId('mdstudio-designer-export-css')).toBeInTheDocument())
    await act(async () => {
      fireEvent.click(screen.getByTestId('mdstudio-designer-export-css'))
    })
    await waitFor(() => expect(writeText).toHaveBeenCalled())
    const css = writeText.mock.calls[0][0]
    expect(css).toContain('.mdcore-doc')
    expect(css).toContain('hljs-keyword')
  })
})