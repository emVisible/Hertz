/** 看板界面的**接缝**测试（v0.34 B）。
 *
 * 这里测的不是「长得对不对」，而是**界面选的东西真的进了请求、后端真的数字真的上屏**：
 *  - `board(day)` 带着归一化后的墙上日期发出去（不是硬编码今天，也不是 `?day=`）
 *  - 「捞入今日 / 移出今日」发出的是 `focus_date = day` / `null`（写入口只有一个）
 *  - 保存目标把草稿发给 `saveGoal(day, text)`，并且**回读**成功后才认「已保存」
 *    （v0.33 前设置页 toast 说已保存而其实没落盘，D-204 —— 这条就是那类缺陷的反面）
 *  - 顶栏的完成度与列头计数用的是**后端的数**（counts 是截断前的数，不是列表长度）
 *
 * 三段都坏过：A 切片当初就是「后端筛好了、界面上没接线」；这一片把接缝钉住。
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { wallDay } from '../../core/boardWindow'

const tCalls: Array<[string, unknown]> = []
// 只换掉 `useTranslation`，其余导出（`initReactI18next` 等）留给真实模块——
// 整体替换会让 `src/i18n/index.ts` 的 `i18n.use(initReactI18next)` 拿到 undefined。
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

const calls: Record<string, unknown[][]> = { board: [], saveGoal: [], setFocus: [] }
// 可变夹具：mock 的 `board()` 在**被调用时**读它，所以每条测试可以先换数据再 render
// （工厂本身在 vi.mock 提升时只求值一次，这里不能读、只能闭包引用）。
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
const inWorkItem = {
  id: 'item-inwork',
  seq: 2,
  status: 'downloaded',
  title: 'Tried to adopt a senior dog',
  focus_date: null,
  focus_note: null,
}

const boardFixture = {
  date: DAY,
  published_from: `${DAY}T00:00:00+00:00`,
  published_to: '2999-01-01T00:00:00+00:00',
  goal_text: '过一遍 AITA 前 20 条',
  goal_updated_at: '2026-09-30T01:00:00+00:00',
  columns: {
    focus: [focusItem],
    in_work: [inWorkItem],
    review: [],
    ready_to_publish: [],
    published_today: [],
  },
  counts: { focus: 2, in_work: 137, review: 0, ready_to_publish: 0, published_today: 0 },
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
          if (prop === 'goal') return Promise.resolve({ goal_date: DAY, goal_text: '', updated_at: null })
          if (prop === 'saveGoal') {
            return Promise.resolve({
              goal_date: args[0],
              goal_text: args[1],
              updated_at: '2026-09-30T02:00:00+00:00',
            })
          }
          if (prop === 'setFocus') {
            return Promise.resolve({ id: args[0], ...(args[1] as object) })
          }
          return Promise.resolve([])
        },
    },
  ),
}))

import { BoardTab, type BoardActions } from './BoardTab'

const wrapper = ({ children }: { children: ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

// BoardTab 只用到这几个动作；其余 props 对它不可达，用最小替身
const p = {
  publishStatus: null,
  setTab: vi.fn(),
  setPreFilters: vi.fn(),
  act: vi.fn(),
  saveMeta: vi.fn(),
  publishItem: vi.fn(),
  randomCover: vi.fn(),
  uploadCover: vi.fn(),
  backToPrep: vi.fn(),
} as unknown as BoardActions

const noop = () => undefined

beforeEach(() => {
  for (const key of Object.keys(calls)) calls[key].length = 0
  tCalls.length = 0
  currentBoard = boardFixture
})

describe('BoardTab 的接缝', () => {
  it('按墙上日期取看板数据', async () => {
    render(<BoardTab p={p} onGoUnscored={noop} />, { wrapper })
    await waitFor(() => expect(calls.board.length).toBeGreaterThan(0))
    expect(calls.board[0][0]).toBe(DAY)
  })

  it('完成度与列头计数用的是后端给的数，不是列表长度', async () => {
    render(<BoardTab p={p} onGoUnscored={noop} />, { wrapper })
    // 先等到数据上屏（截断提示只有 counts>行数 才会渲染，它就是「等到了」的判据；
    // focus 2>1 与 in_work 137>1 都会渲染，所以用 findAll）
    expect((await screen.findAllByText('console.boardTruncated')).length).toBeGreaterThan(1)
    const progress = [...tCalls].reverse().find(([key]) => key === 'console.boardProgress')
    expect(progress, '顶栏没读 progress 就只剩一个装饰文案').toBeDefined()
    expect(progress?.[1]).toMatchObject({ published: 1, focused: 2 })
    // in_work：counts 137 / 只有 1 行 ⇒ 必须报「截断」，不能把 1 当成 137
    const truncated = [...tCalls].reverse().find(([key]) => key === 'console.boardTruncated')
    expect(truncated?.[1]).toMatchObject({ shown: 1, total: 137 })
  })

  it('捞入今日 / 移出今日走同一个写入口，patch 形状正确', async () => {
    render(<BoardTab p={p} onGoUnscored={noop} />, { wrapper })
    await waitFor(() => expect(screen.getAllByText('console.boardPickToday').length).toBe(1))

    fireEvent.click(screen.getByTitle('console.boardPickHint'))
    await waitFor(() => expect(calls.setFocus.length).toBe(1))
    expect(calls.setFocus[0][0]).toBe('item-inwork')
    expect(calls.setFocus[0][1]).toEqual({ focus_date: DAY })

    fireEvent.click(screen.getByTitle('console.boardDropHint'))
    await waitFor(() => expect(calls.setFocus.length).toBe(2))
    expect(calls.setFocus[1][0]).toBe('item-focus')
    expect(calls.setFocus[1][1]).toEqual({ focus_date: null })
  })

  it('目标：没改过不发请求，保存成功后认回读，换了日期不带上旧草稿', async () => {
    render(<BoardTab p={p} onGoUnscored={noop} />, { wrapper })
    const box = await screen.findByRole('textbox')
    await waitFor(() => expect(box).toHaveValue('过一遍 AITA 前 20 条'))

    // 草稿 == 库里的值 ⇒ 按钮 disabled，一次请求都不该发（「点了但没落盘」的反面）
    fireEvent.click(screen.getByText('console.boardGoalSave'))
    expect(calls.saveGoal.length).toBe(0)

    fireEvent.change(box, { target: { value: '改成 30 条' } })
    fireEvent.click(screen.getByText('console.boardGoalSave'))
    await waitFor(() => expect(calls.saveGoal.length).toBe(1))
    expect(calls.saveGoal[0]).toEqual([DAY, '改成 30 条'])
    await waitFor(() => expect(screen.queryByText('console.boardGoalSaved')).not.toBeNull())

    // 换日期：上一天没保存/已保存的草稿都不许跟到新日期去（带上 day 之后
    // `edit.day !== day` 自动作废，按钮回到 disabled）
    const otherDay = '2034-07-04'
    fireEvent.change(box, { target: { value: '这条只属于今天' } })
    fireEvent.change(screen.getByLabelText('console.boardDay'), { target: { value: otherDay } })
    await waitFor(() => expect(box).toHaveValue('过一遍 AITA 前 20 条'))
    fireEvent.click(screen.getByText('console.boardGoalSave'))
    expect(calls.saveGoal.length).toBe(1)
  })

  it('今日列为空时给的是动线，不是死路', async () => {
    // 后端说今天没东西（focus 空）⇒ 界面要能把人送去「未评分 + 情感 + 有正文」。
    // 动线由主壳 compose（设轴 + 切分段 + 换 tab），看板只负责把它摆出来——
    // 所以这里断言的是「回调被原样触发」，分段那一步由壳的测试/浏览器验证覆盖。
    currentBoard = { ...boardFixture, columns: { ...boardFixture.columns, focus: [] } }
    const onGoUnscored = vi.fn()
    render(<BoardTab p={p} onGoUnscored={onGoUnscored} />, { wrapper })
    const go = await screen.findByText('console.boardGoPreReview')
    fireEvent.click(go)
    expect(onGoUnscored).toHaveBeenCalledTimes(1)
  })
})
