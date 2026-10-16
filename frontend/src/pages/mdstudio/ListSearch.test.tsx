/**
 * 稿件列表搜索的判据（P1-4）。
 *
 * 搜索是纯前端过滤：稿件量上来后，"在哪份稿"是每天都会撞到的摩擦。守四件事：
 * ①命中的留下、没命中的隐去；②大小写不敏感（英文稿名）；③空结果的提示；
 * ④**与选中态不互斥**——过滤只是显示层的事，不把当前打开的稿换掉。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import '../../i18n'

const live = [
  { id: 'l1', title: '甲稿：命理入门', platform: 'wechat', theme_id: 'modi', updated_at: '2026-10-15T00:00:00Z' },
  { id: 'l2', title: '乙稿：English Title', platform: 'wechat', theme_id: 'modi', updated_at: '2026-10-14T00:00:00Z' },
]

const docOf = (id: string) => ({
  ...live.find((l) => l.id === id)!,
  source_md: id === 'l1' ? '# 甲正文' : '# 乙正文',
  source_ref: null,
  overrides: {},
  cover: {},
  created_at: '2026-10-15T00:00:00Z',
})

vi.mock('../../api', () => ({
  layoutApi: {
    list: () => Promise.resolve(live),
    listDeleted: () => Promise.resolve([]),
    get: (id: string) => Promise.resolve(docOf(id)),
    update: (id: string) => Promise.resolve(docOf(id)),
  },
  docsApi: { list: () => Promise.resolve([]) },
}))

import { MdStudioPage } from './MdStudioPage'

const wrapper = ({ children }: { children: ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

beforeEach(() => {
  localStorage.clear()
})

describe('稿件列表搜索', () => {
  it('命中：只留下匹配的稿', async () => {
    const user = userEvent.setup()
    render(<MdStudioPage />, { wrapper })
    const search = await screen.findByLabelText('搜索稿')
    await user.type(search, '乙稿')
    await waitFor(() => expect(screen.queryByText('甲稿：命理入门')).toBeNull())
    expect(screen.getByText('乙稿：English Title')).toBeTruthy()
  })

  it('大小写不敏感：小写查大写稿名也命中', async () => {
    const user = userEvent.setup()
    render(<MdStudioPage />, { wrapper })
    const search = await screen.findByLabelText('搜索稿')
    await user.type(search, 'english')
    await waitFor(() => expect(screen.getByText('乙稿：English Title')).toBeTruthy())
    expect(screen.queryByText('甲稿：命理入门')).toBeNull()
  })

  it('空结果：给明确提示，不是一片空白', async () => {
    const user = userEvent.setup()
    render(<MdStudioPage />, { wrapper })
    const search = await screen.findByLabelText('搜索稿')
    await user.type(search, '不存在的稿')
    await waitFor(() => expect(screen.getAllByText('没有找到匹配的稿').length).toBeGreaterThan(0))
  })

  it('清空搜索后全部回来', async () => {
    const user = userEvent.setup()
    render(<MdStudioPage />, { wrapper })
    const search = await screen.findByLabelText('搜索稿')
    await user.type(search, '乙稿')
    await waitFor(() => expect(screen.queryByText('甲稿：命理入门')).toBeNull())
    await user.clear(search)
    await waitFor(() => expect(screen.getByText('甲稿：命理入门')).toBeTruthy())
    expect(screen.getByText('乙稿：English Title')).toBeTruthy()
  })

  it('与选中态不互斥：过滤掉当前打开的稿，画布不换稿', async () => {
    const user = userEvent.setup()
    render(<MdStudioPage />, { wrapper })
    // 先打开甲稿（列表默认选中最新那份，点一下确保选中甲）
    await user.click(await screen.findByText('甲稿：命理入门'))
    await waitFor(() =>
      expect((screen.getByLabelText('稿名') as HTMLInputElement).value).toBe('甲稿：命理入门'),
    )
    // 搜一个只匹配乙稿的词 → 甲稿从列表隐去，但画布仍停在甲稿
    await user.type(await screen.findByLabelText('搜索稿'), '乙稿')
    await waitFor(() => expect(screen.queryByText('甲稿：命理入门')).toBeNull())
    expect((screen.getByLabelText('稿名') as HTMLInputElement).value).toBe('甲稿：命理入门')
  })
})
