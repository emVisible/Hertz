/** 看板「今天」块的**接缝**测试（v0.34 D-218）。
 *
 * 这块的形状是用户两次纠正定下来的，所以测的正是那两条：
 * ① 目标与待办是一个东西 ⇒ **一行一条待办**，点一下就完成（写回的是整段文本，
 *    只改被点那一行——这条判据在 `core/goalChecklist.test.ts`，这里测界面真的用了它）；
 * ② 看板不做设置 ⇒ **没有可编辑目标文字的控件**，出路指向「设置 → 每日目标」。
 * 另外三条老判据继续留着：按墙上日期取数、完成度读后端、条目动作走总线那一个写点。
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { GOAL_MAX_CHARS, wallDay } from '../../core/boardWindow'

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

vi.mock('../../components/execution', () => ({
  PublishCard: ({ item }: { item: { id: string } }) => <div data-testid="publish-card">{item.id}</div>,
  AuditCard: ({ item }: { item: { id: string } }) => <div data-testid="audit-card">{item.id}</div>,
  StageItemRow: ({ item }: { item: { id: string } }) => <div data-testid="stage-row">{item.id}</div>,
}))

const calls: Record<string, unknown[][]> = { board: [], saveGoal: [] }
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
  goal_text: '过一遍 AITA 前 20 条\n挑 5 条改开头\n\n只筛不发做复盘',
  goal_updated_at: '2026-09-30T01:00:00+00:00',
  columns: {
    focus: [focusItem],
    in_work: [],
    review: [],
    ready_to_publish: [],
    published_today: [publishedItem],
  },
  counts: { focus: 1, in_work: 0, review: 0, ready_to_publish: 0, published_today: 1 },
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
          if (prop === 'saveGoal') {
            return Promise.resolve({ goal_date: args[0], goal_text: args[1], updated_at: 'x' })
          }
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
  setFocus: vi.fn(),
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
    render(<TodayPanel p={p} onGoUnscored={noop} onGoGoal={noop} />, { wrapper })
    await waitFor(() => expect(calls.board.length).toBeGreaterThan(0))
    expect(calls.board[0][0]).toBe(DAY)
  })

  it('一行一条待办：三行文本渲染出三个勾选框（空行不算）', async () => {
    render(<TodayPanel p={p} onGoUnscored={noop} onGoGoal={noop} />, { wrapper })
    expect(await screen.findAllByRole('checkbox')).toHaveLength(3)
    expect(screen.getByText('只筛不发做复盘')).toBeInTheDocument()
  })

  it('点一下就是完成：发出去的是「只改那一行」的整段文本', async () => {
    render(<TodayPanel p={p} onGoUnscored={noop} onGoGoal={noop} />, { wrapper })
    const boxes = await screen.findAllByRole('checkbox')
    fireEvent.click(boxes[1])
    await waitFor(() => expect(calls.saveGoal.length).toBe(1))
    expect(calls.saveGoal[0][0]).toBe(DAY)
    expect(calls.saveGoal[0][1]).toBe('过一遍 AITA 前 20 条\n- [x] 挑 5 条改开头\n\n只筛不发做复盘')
    // 勾上的状态来自后端回读那一行，不是界面自己以为成功了
    await waitFor(() => expect(boxes[1]).toBeChecked())
  })

  it('再点一次是取消勾选（文本回到 - [ ]），仍然真发请求', async () => {
    currentBoard = { ...boardFixture, goal_text: '- [x] 已经勾上的条目' }
    render(<TodayPanel p={p} onGoUnscored={noop} onGoGoal={noop} />, { wrapper })
    const box = (await screen.findByRole('checkbox')) as HTMLInputElement
    expect(box).toBeChecked()
    fireEvent.click(box)
    await waitFor(() => expect(calls.saveGoal.length).toBe(1))
    expect(calls.saveGoal[0][1]).toBe('- [ ] 已经勾上的条目')
  })

  it('顶到长度上限时不发请求，并给出说法（勾不上≠坏了）', async () => {
    currentBoard = { ...boardFixture, goal_text: '一'.repeat(GOAL_MAX_CHARS - 2) }
    render(<TodayPanel p={p} onGoUnscored={noop} onGoGoal={noop} />, { wrapper })
    fireEvent.click((await screen.findByRole('checkbox')) as HTMLInputElement)
    expect(calls.saveGoal.length).toBe(0)
    expect(await screen.findByText('dashboard.goalTooLong')).toBeInTheDocument()
  })

  it('看板不编辑目标文字：没有 textarea，出路指向设置', async () => {
    const onGoGoal = vi.fn()
    render(<TodayPanel p={p} onGoUnscored={noop} onGoGoal={onGoGoal} />, { wrapper })
    await screen.findAllByRole('checkbox')
    expect(screen.queryByRole('textbox', { name: 'settings.goalLabel' })).toBeNull()
    expect(document.querySelectorAll('textarea')).toHaveLength(0)
    fireEvent.click(screen.getByText('console.boardGoalSavedAt'))
    expect(onGoGoal).toHaveBeenCalledTimes(1)
  })

  it('没写目标时给的是出路，不是空白', async () => {
    currentBoard = { ...boardFixture, goal_text: '', columns: { ...boardFixture.columns, focus: [] } }
    const onGoGoal = vi.fn()
    const onGoUnscored = vi.fn()
    render(<TodayPanel p={p} onGoUnscored={onGoUnscored} onGoGoal={onGoGoal} />, { wrapper })
    expect(await screen.findByText('dashboard.goalEmpty')).toBeInTheDocument()
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
    fireEvent.click(screen.getByText('dashboard.goalGo'))
    expect(onGoGoal).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByText('console.boardGoPreReview'))
    expect(onGoUnscored).toHaveBeenCalledTimes(1)
  })

  it('完成度报后端的数，条目动作走总线那一个写点', async () => {
    render(<TodayPanel p={p} onGoUnscored={noop} onGoGoal={noop} />, { wrapper })
    await screen.findByText('item-focus')
    // 待办 0/3（勾出来的）与「已发 1 / 捞入 2」（后端 progress）是两个数，都得在
    expect(screen.getByText('dashboard.todoDone')).toBeInTheDocument()
    const progress = [...tCalls].reverse().find(([key]) => key === 'console.boardProgress')
    expect(progress?.[1]).toMatchObject({ published: 1, focused: 2 })

    fireEvent.click(screen.getByTitle('console.boardDropHint'))
    expect(p.setFocus).toHaveBeenLastCalledWith(focusItem, { focus_date: null })

    const note = screen.getByLabelText('console.boardNoteLabel')
    fireEvent.change(note, { target: { value: '结尾加一句反转' } })
    fireEvent.focusOut(note)
    expect(p.setFocus).toHaveBeenLastCalledWith(focusItem, {
      focus_date: DAY,
      focus_note: '结尾加一句反转',
    })
  })

  it('今日已发的收尾动作走总线那同一个函数', async () => {
    render(<TodayPanel p={p} onGoUnscored={noop} onGoGoal={noop} />, { wrapper })
    await screen.findByText('My husband hid his student loans')
    fireEvent.click(screen.getByTitle('console.backToReviewHint'))
    expect(p.act).toHaveBeenCalledWith(publishedItem, 'requeue')
    fireEvent.click(screen.getByTitle('console.statsHint'))
    expect(p.setPublishStats).toHaveBeenCalledWith(publishedItem)
  })
})
