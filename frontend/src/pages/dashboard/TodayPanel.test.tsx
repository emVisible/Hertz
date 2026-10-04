/** 「今日待办」悬浮栏的接缝测试（v0.34 D-219）。
 *
 * 这块现在的形状来自用户两句原话：
 * ①「把这个今日待办做成一个悬浮的，放在看板右侧」；
 * ②「原来今日待办下面那两部分删掉，就保留上面的部分……有一个最简单的指标就可以了」。
 * 所以这里测的是：目标清单真的可勾（写回只改被点那一行）、指标只用后端的数、
 * 条目列表与今日已发那排 chip 真的不在这儿了，而**改文字仍然不在看板上**。
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

// 卡片替身：看板现在不该用到它们，留着 mock 是让「一条都没渲染」这条断言可判
vi.mock('../../components/execution', () => ({
  PublishCard: ({ item }: { item: { id: string } }) => <div data-testid="publish-card">{item.id}</div>,
  AuditCard: ({ item }: { item: { id: string } }) => <div data-testid="audit-card">{item.id}</div>,
  StageItemRow: ({ item }: { item: { id: string } }) => <div data-testid="stage-row">{item.id}</div>,
}))

const calls: Record<string, unknown[][]> = { board: [], saveGoal: [] }
let currentBoard: unknown = {}

const DAY = wallDay()

const boardFixture = {
  date: DAY,
  published_from: `${DAY}T00:00:00+00:00`,
  published_to: '2999-01-01T00:00:00+00:00',
  goal_text: '过一遍 AITA 前 20 条\n挑 5 条改开头\n\n只筛不发做复盘',
  goal_updated_at: '2026-09-30T01:00:00+00:00',
  columns: {
    focus: [{ id: 'item-focus', seq: 3, status: 'scored', title: 'AITA by skipping the funeral', focus_date: DAY }],
    in_work: [],
    review: [],
    ready_to_publish: [],
    published_today: [{ id: 'item-pub', seq: 4, status: 'published', title: 'My husband hid his loans' }],
  },
  counts: { focus: 1, in_work: 0, review: 0, ready_to_publish: 0, published_today: 1 },
  // 后端的数：捞入 2、其中今天已发 1、库里 focus 只给了 1 行——界面必须报 1 而不是列表长度
  progress: { focused: 2, published_of_focus: 1 },
}

vi.mock('../../api', () => ({
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

const wrapper = ({ children }: { children: ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

beforeEach(() => {
  for (const key of Object.keys(calls)) calls[key].length = 0
  tCalls.length = 0
  currentBoard = boardFixture
})

describe('今日待办悬浮栏的接缝', () => {
  it('按墙上日期取数', async () => {
    render(<TodayPanel onGoGoal={vi.fn()} />, { wrapper })
    await waitFor(() => expect(calls.board.length).toBeGreaterThan(0))
    expect(calls.board[0][0]).toBe(DAY)
  })

  it('一行一条待办：三行文本渲染三个勾选框（空行不算）', async () => {
    render(<TodayPanel onGoGoal={vi.fn()} />, { wrapper })
    expect(await screen.findAllByRole('checkbox')).toHaveLength(3)
    expect(screen.getByText('只筛不发做复盘')).toBeInTheDocument()
  })

  it('点一下就是完成：发出去的是「只改被点那一行」的整段文本', async () => {
    render(<TodayPanel onGoGoal={vi.fn()} />, { wrapper })
    const boxes = await screen.findAllByRole('checkbox')
    fireEvent.click(boxes[1])
    await waitFor(() => expect(calls.saveGoal.length).toBe(1))
    expect(calls.saveGoal[0][0]).toBe(DAY)
    expect(calls.saveGoal[0][1]).toBe('过一遍 AITA 前 20 条\n- [x] 挑 5 条改开头\n\n只筛不发做复盘')
    await waitFor(() => expect(boxes[1]).toBeChecked())
  })

  it('再点一次是取消勾选（文本回到 - [ ]），仍然真发请求', async () => {
    currentBoard = { ...boardFixture, goal_text: '- [x] 已经勾上的条目' }
    render(<TodayPanel onGoGoal={vi.fn()} />, { wrapper })
    const box = (await screen.findByRole('checkbox')) as HTMLInputElement
    expect(box).toBeChecked()
    fireEvent.click(box)
    await waitFor(() => expect(calls.saveGoal.length).toBe(1))
    expect(calls.saveGoal[0][1]).toBe('- [ ] 已经勾上的条目')
  })

  it('顶到长度上限时不发请求，并给出说法（勾不上≠坏了）', async () => {
    currentBoard = { ...boardFixture, goal_text: '一'.repeat(GOAL_MAX_CHARS - 2) }
    render(<TodayPanel onGoGoal={vi.fn()} />, { wrapper })
    fireEvent.click((await screen.findByRole('checkbox')) as HTMLInputElement)
    expect(calls.saveGoal.length).toBe(0)
    expect(await screen.findByText('dashboard.goalTooLong')).toBeInTheDocument()
  })

  it('一行里的 tag 渲染在右侧：第一个字段是目标，后面的是标签（D-221）', async () => {
    currentBoard = { ...boardFixture, goal_text: '改开头 AITA 高质量\n只筛不发' }
    const { container } = render(<TodayPanel onGoGoal={vi.fn()} />, { wrapper })
    await screen.findAllByRole('checkbox')
    // 目标那一格只剩第一个字段，其余字段变成 chip
    expect(screen.getByText('改开头')).toBeInTheDocument()
    expect(screen.queryByText('改开头 AITA 高质量')).toBeNull()
    expect(screen.getByText('AITA')).toBeInTheDocument()
    expect(screen.getByText('高质量')).toBeInTheDocument()
    // 没有 tag 的行不生出空 chip
    expect(container.querySelectorAll('label span span').length).toBe(2)
  })

  it('沿用最近一份时洗掉昨天的勾，并说清沿自哪天（D-220）', async () => {
    currentBoard = {
      ...boardFixture,
      goal_text: '- [x] 捞 5 条进今日\n改完 3 个开头',
      goal_carried_from: '2034-08-01',
    }
    render(<TodayPanel onGoGoal={vi.fn()} />, { wrapper })
    const boxes = await screen.findAllByRole('checkbox')
    expect(boxes).toHaveLength(2)
    expect(boxes[0], '昨天勾过的不该算今天的完成').not.toBeChecked()
    expect(await screen.findByText('dashboard.goalCarriedFrom')).toBeInTheDocument()
    // 「上次保存」这时不该出现——它是昨天那次保存的时间，画在今天会被读成数据陈旧
    expect(screen.queryByText('console.boardGoalSavedAt')).toBeNull()
  })

  it('最简指标用的是后端的 progress，不是列表长度', async () => {
    render(<TodayPanel onGoGoal={vi.fn()} />, { wrapper })
    // 先等到数据上屏（清单渲染出来才算），否则取到的是首帧的 0
    await screen.findAllByRole('checkbox')
    const published = [...tCalls].reverse().find(([key]) => key === 'dashboard.publishedToday')
    expect(published, '悬浮栏没读 progress 就只剩一个装饰文案').toBeDefined()
    expect(published?.[1]).toEqual({ n: 1 })
  })

  it('下面那两部分真的没了：不画条目卡，也不画今日已发那排 chip', async () => {
    const { container } = render(<TodayPanel onGoGoal={vi.fn()} />, { wrapper })
    await screen.findAllByRole('checkbox')
    expect(container.querySelectorAll('[data-testid="publish-card"],[data-testid="audit-card"],[data-testid="stage-row"]')).toHaveLength(0)
    // 「空态动线」那两句也不该再出现（用户点名删掉）
    const text = container.textContent ?? ''
    expect(text).not.toContain('console.boardEmptyFocus')
    expect(text).not.toContain('console.boardGoPreReview')
    // 对照组：整段文本里确实渲染了东西，不是整个组件没挂
    expect(text).toContain('console.boardColFocus')
  })

  it('看板不编辑目标文字：没有 textarea，出路两处都指向设置', async () => {
    const onGoGoal = vi.fn()
    render(<TodayPanel onGoGoal={onGoGoal} />, { wrapper })
    await screen.findAllByRole('checkbox')
    expect(document.querySelectorAll('textarea')).toHaveLength(0)
    fireEvent.click(screen.getByText('dashboard.goalEditText'))
    fireEvent.click(screen.getByText('console.boardGoalSavedAt'))
    expect(onGoGoal).toHaveBeenCalledTimes(2)
  })

  it('没写目标时给的是出路，不是空白', async () => {
    currentBoard = { ...boardFixture, goal_text: '' }
    const onGoGoal = vi.fn()
    render(<TodayPanel onGoGoal={onGoGoal} />, { wrapper })
    expect(await screen.findByText('dashboard.goalEmpty')).toBeInTheDocument()
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
    fireEvent.click(screen.getByText('dashboard.goalGo'))
    expect(onGoGoal).toHaveBeenCalledTimes(1)
  })
})
