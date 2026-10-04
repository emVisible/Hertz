/** 看板「供给」栏的接缝测试（v0.34 重设计）。
 *
 * 三条都是这块的形状本身带来的风险：
 * ① 计数必须用后端 `counts`（截断**前**），列表只画得下前几条——把 1 当成 137 报
 *    是这一片最容易犯也最难看出来的错；
 * ② 待审 / 待发布两列是界面上**唯一**的单条过审与发布入口（原「发布」tab 已并进看板），
 *    所以它们不许被压成纯文字清单——那样 approved 条目就再也发不出去了；
 * ③ 捞入今日发的是 `focus_date = 当天`。
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { wallDay } from '../../core/boardWindow'

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) }
})

vi.mock('../../components/execution', () => ({
  PublishCard: ({ item }: { item: { id: string } }) => <div data-testid="publish-card">{item.id}</div>,
  AuditCard: ({ item }: { item: { id: string } }) => <div data-testid="audit-card">{item.id}</div>,
  StageItemRow: ({ item }: { item: { id: string } }) => <div data-testid="stage-row">{item.id}</div>,
}))

const calls: Record<string, unknown[][]> = { board: [], counts: [], trends: [] }
const apiCalls: string[] = []
const navigated: string[] = []
let currentBoard: unknown = {}
const DAY = wallDay()

// 只喂 `useNavigate` 这一个钩子——供给栏里唯一的跳转是「去流水线」
vi.mock('react-router-dom', () => ({
  useNavigate: () => (to: string) => navigated.push(to),
}))

const queuedItem = { id: 'item-q', seq: 5, status: 'queued', title: 'My mom rewrote my wedding vows' }
const approvedItem = { id: 'item-a', seq: 6, status: 'approved', title: 'He hid the adoption papers' }

const boardFixture = {
  date: DAY,
  published_from: `${DAY}T00:00:00+00:00`,
  published_to: '2999-01-01T00:00:00+00:00',
  goal_text: '',
  goal_updated_at: null,
  columns: {
    focus: [],
    in_work: [],
    review: [queuedItem],
    ready_to_publish: [approvedItem],
    published_today: [],
  },
  counts: { focus: 0, in_work: 0, review: 137, ready_to_publish: 1, published_today: 0 },
  progress: { focused: 0, published_of_focus: 0 },
}

vi.mock('../../api', () => ({
  api: {
    get: vi.fn(async (path: string) => {
      apiCalls.push(path)
      return null
    }),
    post: vi.fn(async () => ({})),
  },
  pipelineApi: new Proxy(
    {},
    {
      get:
        (_target, prop: string) =>
        (...args: unknown[]) => {
          if (prop in calls) calls[prop].push(args)
          if (prop === 'board') return Promise.resolve(currentBoard)
          if (prop === 'counts') return Promise.resolve({ queued: 137, approved: 1 })
          return Promise.resolve([])
        },
    },
  ),
}))

import { SupplyPanel } from './SupplyPanel'
import type { BoardActions } from './boardActions'

const wrapper = ({ children }: { children: ReactNode }) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

const p = { publishStatus: null, act: vi.fn(), setPublishStats: vi.fn() } as unknown as BoardActions

beforeEach(() => {
  for (const key of Object.keys(calls)) calls[key].length = 0
  apiCalls.length = 0
  navigated.length = 0
  currentBoard = boardFixture
})

describe('SupplyPanel 的接缝', () => {
  it('列头计数用截断前的 counts，并说清只显示了几条', async () => {
    render(<SupplyPanel p={p} onFocus={vi.fn()} />, { wrapper })
    await waitFor(() => expect(screen.getByTestId('audit-card')).toBeInTheDocument())
    // review：counts 137 / 只画 1 条 ⇒ 必须写「137」并给出截断提示
    expect(screen.getAllByText('137').length).toBeGreaterThan(0)
    expect(screen.getByText('console.boardTruncated')).toBeInTheDocument()
  })

  it('待审 / 待发布仍挂得动卡片（界面上唯一的单条过审与发布入口）', async () => {
    render(<SupplyPanel p={p} onFocus={vi.fn()} />, { wrapper })
    await waitFor(() => expect(screen.getByTestId('publish-card')).toBeInTheDocument())
    expect(screen.getByTestId('audit-card')).toHaveTextContent('item-q')
    expect(screen.getByTestId('publish-card')).toHaveTextContent('item-a')
  })

  it('捞入今日发的是 focus_date = 当天', async () => {
    const onFocus = vi.fn()
    render(<SupplyPanel p={p} onFocus={onFocus} />, { wrapper })
    await waitFor(() => expect(screen.getByTestId('audit-card')).toBeInTheDocument())
    fireEvent.click(screen.getAllByTitle('console.boardPickHint')[0])
    expect(onFocus).toHaveBeenCalledWith(queuedItem, { focus_date: DAY })
  })

  it('频道洞察读的是既有那个缓存键的端点，不多开一路', async () => {
    render(<SupplyPanel p={p} onFocus={vi.fn()} />, { wrapper })
    await waitFor(() => expect(apiCalls).toContain('/api/ai/insights'))
  })

  it('「去流水线」真的跳到流水线（供给栏不做设置，动手的地方在那边）', async () => {
    render(<SupplyPanel p={p} onFocus={vi.fn()} />, { wrapper })
    // 按钮文案是「去流水线 ↗」，箭头和文字在同一个元素里，所以用正则匹配
    fireEvent.click(await screen.findByText(/dashboard\.goPipeline/))
    expect(navigated).toEqual(['/execution?mode=pipeline'])
  })
})
