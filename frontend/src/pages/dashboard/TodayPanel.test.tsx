/** 看板「今天」栏的**接缝**测试（v0.34 重设计）。
 *
 * 测的不是「长得对不对」，而是**界面选的东西真的进了请求、后端真的数真的上屏**：
 *  - `board(day)` 带着归一化后的墙上日期发出去（不是硬编码今天，也不是 `?day=`）
 *  - 「移出今日 / 改备注」发出的是 `focus_date = null` / `{focus_date, focus_note}`
 *  - 完成度与列头用的是**后端的数**（progress，不是前端自己数列表长度）
 *  - 目标**只读**：这块里没有可编辑的目标框，出路是「设置 → 每日目标」
 *  - 今日已发的两条收尾动作（打回审核 / 补录数据）真的走到总线那同一个函数上
 *
 * 写目标本身的接缝在 `pages/settings/sections/GoalSection.test.tsx`（编辑处搬过去了）。
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { wallDay } from '../../core/boardWindow'

const tCalls: Array<[string, unknown]> = []
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, opts?: unknown) => {
        tCalls.push([key, opts])
        return key
      },
    }),
  }
})

// 卡片替身：这三张卡自己的测试在流水线那侧，这里只关心「今天」栏把它们挂对了地方
vi.mock('../../components/execution', () => ({
  PublishCard: ({ item }: { item: { id: string } }) => <div data-testid="publish-card">{item.id}</div>,
  AuditCard: ({ item }: { item: { id: string } }) => <div data-testid="audit-card">{item.id}</div>,
  StageItemRow: ({ item }: { item: { id: string } }) => <div data-testid="stage-row">{item.id}</div>,
}))

const calls: Record<string, unknown[][]> = { board: [], setFocus: [] }
let currentBoard: unknown = {}

const DAY = wallDay()
const focusItem = {
  id: 'item-focus',
  seq: 3,
  status: 'scored',
  title: 'AITA by skipping the funeral',
  focus_date: DAY,
  focus_note: '开头太散，重写钩子',
}
const publishedItem = {
  id: 'item-pub',
  seq: 4,
  status: 'published',
  title: 'My husband hid his student loans',
  focus_date: DAY,
  published_at: `${DAY}T09:00:00+00:00`,
}

const boardFixture = {
  date: DAY,
  published_from: `${DAY}T00:00:00+00:00`,
  published_to: '2999-01-01T00:00:00+00:00',
  goal_text: '过一遍 AITA 前 20 条',
  goal_updated_at: '2026-09-30T01:00:00+00:00',
  columns: {
    focus: [focusItem],
    in_work: [],
    review: [],
    ready_to_publish: [],
    published_today: [publishedItem],
  },
  counts: { focus: 2, in_work: 0, review: 0, ready_to_publish: 0, published_today: 1 },
  progress: { focused: 2, published_of_focus: 1 },
}

vi.mock('../../api', () => ({
  api: { get: vi.fn(async () => ({})), post: vi.fn(async () => ({})) },
  pipelineApi: new Proxy(
    {},
    {
      get:
        (_target, prop: string) =>
        (...args: unknown[]) => {
          if (prop in calls) calls[prop].push(args)
          if (prop === 'board') return Promise.resolve(currentBoard)
          return Promise.resolve([])
        },
    },
  ),
}))

import { TodayPanel } from './TodayPanel'
import type { BoardActions } from './boardActions'

const wrapper = ({ children }: { children: ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

const p = {
  publishStatus: null,
  act: vi.fn(),
  saveMeta: vi.fn(),
  publishItem: vi.fn(),
  randomCover: vi.fn(),
  uploadCover: vi.fn(),
  backToPrep: vi.fn(),
  setPublishStats: vi.fn(),
} as unknown as BoardActions

const noop = () => undefined

beforeEach(() => {
  for (const key of Object.keys(calls)) calls[key].length = 0
  tCalls.length = 0
  currentBoard = boardFixture
})

describe('TodayPanel 的接缝', () => {
  it('按墙上日期取看板数据', async () => {
    render(<TodayPanel p={p} onFocus={noop} onGoUnscored={noop} onGoGoal={noop} />, { wrapper })
    await waitFor(() => expect(calls.board.length).toBeGreaterThan(0))
    expect(calls.board[0][0]).toBe(DAY)
  })

  it('完成度用的是后端 progress，不是前端数列表', async () => {
    render(<TodayPanel p={p} onFocus={noop} onGoUnscored={noop} onGoGoal={noop} />, { wrapper })
    expect(await screen.findByText('item-focus')).toBeInTheDocument()
    // focus 列只有 1 行，progress 却是 1/2 —— 界面必须报 2（截断/漏数都不能冒充）
    const progress = [...tCalls].reverse().find(([key]) => key === 'console.boardProgress')
    expect(progress, '顶栏没读 progress 就只剩一个装饰文案').toBeDefined()
    expect(progress?.[1]).toMatchObject({ published: 1, focused: 2 })
  })

  it('移出今日 / 改备注发的是同一个 patch 形状', async () => {
    const onFocus = vi.fn()
    render(<TodayPanel p={p} onFocus={onFocus} onGoUnscored={noop} onGoGoal={noop} />, { wrapper })
    await screen.findByText('item-focus')

    fireEvent.click(screen.getByTitle('console.boardDropHint'))
    expect(onFocus).toHaveBeenLastCalledWith(focusItem, { focus_date: null })

    const note = screen.getByLabelText('console.boardNoteLabel')
    fireEvent.change(note, { target: { value: '结尾加一句反转' } })
    fireEvent.focusOut(note)
    expect(onFocus).toHaveBeenLastCalledWith(focusItem, {
      focus_date: DAY,
      focus_note: '结尾加一句反转',
    })
  })

  it('目标只读：没有可编辑的目标框，出路指向设置', async () => {
    const onGoGoal = vi.fn()
    render(<TodayPanel p={p} onFocus={noop} onGoUnscored={noop} onGoGoal={onGoGoal} />, { wrapper })
    // 目标原文照显示（来自后端 `goal_text`），但它不是 input——唯一的文本框是备注
    expect(await screen.findByText('过一遍 AITA 前 20 条')).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'settings.goalLabel' })).toBeNull()
    fireEvent.click(screen.getByText('console.boardGoalSavedAt'))
    expect(onGoGoal).toHaveBeenCalledTimes(1)
  })

  it('没写目标时给的是出路，不是空白', async () => {
    currentBoard = { ...boardFixture, goal_text: '', columns: { ...boardFixture.columns, focus: [] } }
    const onGoGoal = vi.fn()
    const onGoUnscored = vi.fn()
    render(<TodayPanel p={p} onFocus={noop} onGoUnscored={onGoUnscored} onGoGoal={onGoGoal} />, { wrapper })
    fireEvent.click(await screen.findByText('dashboard.goalGo'))
    expect(onGoGoal).toHaveBeenCalledTimes(1)
    // 空今日列同时给动线（去未评分区捞素材），两条出路都在
    fireEvent.click(screen.getByText('console.boardGoPreReview'))
    expect(onGoUnscored).toHaveBeenCalledTimes(1)
  })

  it('今日已发的收尾动作走总线那同一个函数', async () => {
    render(<TodayPanel p={p} onFocus={noop} onGoUnscored={noop} onGoGoal={noop} />, { wrapper })
    await screen.findByText('My husband hid his student loans')
    fireEvent.click(screen.getByTitle('console.backToReviewHint'))
    expect(p.act).toHaveBeenCalledWith(publishedItem, 'requeue')
    fireEvent.click(screen.getByTitle('console.statsHint'))
    expect(p.setPublishStats).toHaveBeenCalledWith(publishedItem)
  })
})
