/** 看板「今天」页里那一节供给的接缝测试（v0.34 D-218）。
 *
 * 只剩读数了：待处理两列搬去流水线之后，这块不该再有任何写入口——
 * 所以这里测的是「数从后端来」+「跳转仍在」，不测按钮。
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) }
})

const apiCalls: string[] = []
const navigated: string[] = []
vi.mock('react-router-dom', () => ({
  useNavigate: () => (to: string) => navigated.push(to),
}))

let currentCounts: Record<string, number> = {}

vi.mock('../../api', () => ({
  api: {
    get: vi.fn(async (path: string) => {
      apiCalls.push(path)
      return null
    }),
    post: vi.fn(async () => ({})),
  },
  pipelineApi: {
    counts: async () => {
      apiCalls.push('/counts')
      return currentCounts
    },
    trends: async () => [],
  },
}))

import { SupplySection } from './SupplySection'

const wrapper = ({ children }: { children: ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

beforeEach(() => {
  apiCalls.length = 0
  navigated.length = 0
  currentCounts = { discovered: 2659, approved: 2, published: 19 }
})

describe('SupplySection 的接缝', () => {
  it('水位用的是后端的数', async () => {
    render(<SupplySection />, { wrapper })
    expect(await screen.findByText('2659')).toBeInTheDocument()
    expect(screen.getByText('19')).toBeInTheDocument()
  })

  it('不再承载任何条目动作（捞入/发布都搬去流水线了）', () => {
    const { container } = render(<SupplySection />, { wrapper })
    const buttons = [...container.querySelectorAll('button')].map((b) => b.textContent?.trim())
    // 只剩两类控件：跳转流水线 + 洞察重新分析（洞察数据为空时连这个都没有）
    expect(buttons.filter((s) => s?.includes('捞入'))).toEqual([])
    expect(buttons.filter((s) => s?.includes('发布'))).toEqual([])
    expect(buttons).toContain('dashboard.goPipeline ↗')
  })

  it('「去流水线」跳过去，洞察读的是既有那个端点', async () => {
    render(<SupplySection />, { wrapper })
    await waitFor(() => expect(apiCalls).toContain('/api/ai/insights'))
    // 按钮文案带箭头，所以用正则匹配
    fireEvent.click(await screen.findByText(/dashboard\.goPipeline/))
    expect(navigated).toEqual(['/execution?mode=pipeline'])
  })
})
