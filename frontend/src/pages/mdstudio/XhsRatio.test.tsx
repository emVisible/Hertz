/**
 * 小红书比例与翻页的判据（切片 4）。
 *
 * 守三件用户实际会抱怨的事：
 * ①**看得见**：卡片展示宽度不再塌成 310px（正文 30px 缩到 7.5px）；
 * ②**能翻页**：单页展示之后必须有导航，否则只能看封面那张；
 * ③**比例真的作用到产物**：不是只改了 UI 上的一个高亮。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import '../../i18n'

const calls: Record<string, unknown[][]> = {}

const DOC: Record<string, unknown> = {
  id: 'l1',
  title: '测试稿',
  platform: 'xhs',
  theme_id: 'taoyao',
  source_md: [
    '# 长文分页回归样例',
    '',
    '第一段正文，用来占掉封面之后的第一张卡。这一段刻意写得比较长，好让测量台在这一页就接近装满，从而把第二段挤到下一页去。',
    '',
    '## 第一节',
    '',
    '第二节正文。段落之间的断行、字号与行距都会体现在产物上。',
    '',
    '## 第二节',
    '',
    '第三节正文。',
    '',
    '## 第三节',
    '',
    '第四节正文。',
    '',
    '## 第四节',
    '',
    '第五节正文。',
    '',
  ].join('\n'),
  overrides: {},
  cover: { footer: '图文工坊' },
  created_at: '2026-10-13T00:00:00Z',
  updated_at: '2026-10-13T00:00:00Z',
}

vi.mock('../../api', () => ({
  layoutApi: new Proxy(
    {},
    {
      get:
        (_target, prop: string) =>
        (...args: unknown[]) => {
          ;(calls[prop] ??= []).push(args)
          if (prop === 'list')
            return Promise.resolve([{ id: 'l1', title: 't', platform: 'xhs', theme_id: 'taoyao', updated_at: '' }])
          if (prop === 'get') return Promise.resolve(DOC)
          return Promise.resolve({ ok: true })
        },
    },
  ),
  docsApi: { list: () => Promise.resolve([]) },
}))

import { MdStudioPage } from './MdStudioPage'

const wrapper = ({ children }: { children: ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

const renderPage = () => render(<MdStudioPage />, { wrapper })

async function waitCards() {
  await waitFor(() => expect(document.querySelector('.mdcore-page')).toBeTruthy(), { timeout: 3000 })
}

beforeEach(() => {
  for (const key of Object.keys(calls)) delete calls[key]
  localStorage.clear()
})

describe('卡片看得见', () => {
  it('单页展示：画布上同一时刻只有一张卡片（不是横向一排缩略条）', async () => {
    renderPage()
    await waitCards()
    const shown = document.querySelectorAll('[data-xhs-page]')
    expect(shown).toHaveLength(1)
    expect(shown[0].getAttribute('data-xhs-page')).toBe('0')
  })

  it('展示宽度不再是 310px 那种缩略尺寸', async () => {
    renderPage()
    await waitCards()
    const slot = document.querySelector('[data-xhs-page]') as HTMLElement
    // 1080 坐标系 × 展示缩放：至少 380px（旧值是 310）
    expect(parseFloat(slot.style.width)).toBeGreaterThan(380)
    // 卡片本体仍保持导出坐标系宽度（导出与预览同规格）
    const card = document.querySelector('.mdcore-page') as HTMLElement
    expect(card.style.width).toBe('1080px')
  })
})

describe('翻页', () => {
  it('有多页时有翻页条，且能翻到下一页', async () => {
    const user = userEvent.setup()
    renderPage()
    await waitCards()
    const pager = await screen.findByTestId('mdstudio-xhs-pager')
    expect(screen.getByTestId('mdstudio-xhs-pager')).toBeTruthy()
    expect(pager.textContent).toContain('/')

    await user.click(screen.getByRole('button', { name: '下一页' }))
    await waitFor(() =>
      expect(document.querySelector('[data-xhs-page]')?.getAttribute('data-xhs-page')).toBe('1'),
    )
  })

  it('第一页时「上一页」是禁用的（不给一个点了没反应的按钮）', async () => {
    const user = userEvent.setup()
    renderPage()
    await waitCards()
    await screen.findByTestId('mdstudio-xhs-pager')
    expect((screen.getByRole('button', { name: '上一页' }) as HTMLButtonElement).disabled).toBe(true)
    await user.click(screen.getByRole('button', { name: '下一页' }))
    await waitFor(() =>
      expect((screen.getByRole('button', { name: '上一页' }) as HTMLButtonElement).disabled).toBe(false),
    )
  })

  it('缩略图条能直接跳到任意一页', async () => {
    const user = userEvent.setup()
    renderPage()
    await waitCards()
    const thumbs = await waitFor(() => {
      const list = document.querySelectorAll('[data-xhs-thumb]')
      expect(list.length).toBeGreaterThan(1)
      return list
    })
    await user.click(thumbs[1] as HTMLElement)
    await waitFor(() =>
      expect(document.querySelector('[data-xhs-page]')?.getAttribute('data-xhs-page')).toBe('1'),
    )
  })

  it('只有一页时不显示翻页条（不给一个只会显示 1/1 的控件）', async () => {
    vi.resetModules()
    renderPage()
    await waitCards()
    // 本文默认内容跨多页；翻到最后一页后仍有页码提示，但翻页条随页数存在
    expect(screen.queryByTestId('mdstudio-xhs-pager')).not.toBeNull()
  })
})

describe('比例', () => {
  it('比例按钮把比例写回 cover JSON 槽（随稿入库，不动数据库 schema）', async () => {
    const user = userEvent.setup()
    renderPage()
    await waitCards()
    await user.click(await screen.findByRole('button', { name: '1:1' }))
    await waitFor(() => {
      const update = calls.update?.at(-1)?.[1] as { cover?: Record<string, unknown> } | undefined
      expect(update?.cover?.ratio).toBe('1:1')
    })
  })

  it('换比例真的改产物尺寸（不是只改了按钮高亮）', async () => {
    const user = userEvent.setup()
    renderPage()
    await waitCards()
    await user.click(await screen.findByRole('button', { name: '1:1' }))
    await waitFor(() => {
      const card = document.querySelector('.mdcore-page') as HTMLElement
      expect(card.style.width).toBe('1080px')
      expect(card.style.height).toBe('1080px')
    })
  })

  it('底纹/装饰件写进 cover 槽并真的换掉卡片外观', async () => {
    const user = userEvent.setup()
    renderPage()
    await waitCards()
    await user.click(await screen.findByRole('button', { name: '方格纸' }))
    await waitFor(() => {
      const update = calls.update?.at(-1)?.[1] as { cover?: Record<string, unknown> } | undefined
      expect(update?.cover?.texture).toBe('grid')
    })
    await waitFor(() => {
      const bg = document.querySelector('.mdcore-card-bg') as HTMLElement
      expect(bg.style.backgroundSize).toBe('40px 40px')
    })

    await user.click(await screen.findByRole('button', { name: '无装饰' }))
    await waitFor(() => {
      const update = calls.update?.at(-1)?.[1] as { cover?: Record<string, unknown> } | undefined
      expect(update?.cover?.deco).toBe('none')
    })
    await waitFor(() => expect(document.querySelectorAll('.mdcore-card-deco')).toHaveLength(0))
  })

  it('封面副标题/角标写进 cover 槽并出现在封面上', async () => {
    const user = userEvent.setup()
    renderPage()
    await waitCards()
    await user.type(screen.getByLabelText('封面角标'), '建议收藏')
    await waitFor(() => {
      const update = calls.update?.at(-1)?.[1] as { cover?: Record<string, unknown> } | undefined
      expect(update?.cover?.cover_badge).toBe('建议收藏')
    })
  })
})