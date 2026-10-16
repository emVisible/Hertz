/**
 * 合规横幅「忽略」的宿主接线判据（P0-1 补齐）。
 *
 * 为什么要测在这一层：`ComplianceBanner.test.tsx` 只证明「onIgnore 被调用」，
 * 但调用之后账本怎么记在宿主手里——第一版宿主按 `matched`（逃逸原文）过滤，
 * 而 onIgnore 传的是 `term`（词表原形），于是「改·运」「gy」这类命中点了忽略
 * 有去无回，横幅纹丝不动；纯词的命中却能用，手测很容易滑过去。第二版又把白名单
 * 只放在会话内存里，计划写的是「随稿存 cover 槽」——刷新即失忆，等于没忽略。
 *
 * 判据（成对变异：过滤字段改回 `matched` 即红；去掉落库/读回即红）：
 * ① 逃逸写法命中（改·运）出现横幅，点忽略后消失；
 * ② 忽略随稿落库（cover.compliance_whitelist 带 term 原形）；
 * ③ 库里已带白名单的稿，打开就不出现横幅。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import '../../i18n'

const live = [
  { id: 'c1', title: '丙稿：合规', platform: 'wechat', theme_id: 'modi', updated_at: '2026-10-15T00:00:00Z' },
]

const { updateCalls, docState } = vi.hoisted(() => ({
  updateCalls: [] as Array<Record<string, unknown>>,
  docState: { cover: {} as Record<string, unknown> },
}))

vi.mock('../../api', () => ({
  layoutApi: {
    list: () => Promise.resolve(live),
    listDeleted: () => Promise.resolve([]),
    get: () => Promise.resolve({
      ...live[0],
      source_md: '# 丙正文\n\n今天讲改·运的法子。',
      source_ref: null,
      overrides: {},
      cover: { ...docState.cover },
      created_at: '2026-10-15T00:00:00Z',
    }),
    update: (_id: string, body: Record<string, unknown>) => {
      updateCalls.push(body)
      return Promise.resolve({ ...live[0], ...body })
    },
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
  updateCalls.length = 0
  docState.cover = {}
})

describe('合规横幅忽略接线', () => {
  it('逃逸命中出现横幅，点忽略后消失（按 term 过滤）', async () => {
    const user = userEvent.setup()
    render(<MdStudioPage />, { wrapper })

    const banner = await screen.findByTestId('mdstudio-compliance')
    expect(banner.textContent).toContain('发现 1 处敏感内容')

    await user.click(within(banner).getByText('展开'))
    // 忽略按钮文案是词表原形（term=改运），而不是逃逸原文（改·运）
    await user.click(within(banner).getByText('忽略 改运'))

    await waitFor(() => expect(screen.queryByTestId('mdstudio-compliance')).toBeNull())
  })

  it('忽略随稿落库：cover.compliance_whitelist 存 term 原形', async () => {
    const user = userEvent.setup()
    render(<MdStudioPage />, { wrapper })

    const banner = await screen.findByTestId('mdstudio-compliance')
    await user.click(within(banner).getByText('展开'))
    await user.click(within(banner).getByText('忽略 改运'))

    // 自动保存是 800ms debounce 的 PUT：等它真的带着白名单出门
    await waitFor(() => expect(updateCalls.length).toBeGreaterThan(0), { timeout: 3000 })
    const cover = updateCalls.at(-1)!.cover as Record<string, unknown>
    expect(cover.compliance_whitelist).toEqual(['改运'])
  })

  it('库里已带白名单的稿，打开就不出现横幅', async () => {
    docState.cover = { compliance_whitelist: ['改运'] }
    render(<MdStudioPage />, { wrapper })

    await screen.findByDisplayValue('丙稿：合规')
    // 等过渲染防抖（150ms）再看：命中文本仍在，但已被白名单豁免
    await new Promise((r) => setTimeout(r, 400))
    expect(screen.queryByTestId('mdstudio-compliance')).toBeNull()
  })
})
