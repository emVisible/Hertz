/** 「设置 → 每日目标」的接缝测试（v0.34 重设计）。
 *
 * 这一节是从看板搬过来的，搬的东西包括从前钉在这里的那条真缺陷：**换过日期还拿着
 * 上一天的草稿**（界面显示新一天的目标，点保存写进库里的却是昨天的字）。
 * 所以「换日期 ⇒ 草稿作废」必须继续被测到，哪怕编辑器搬了家。
 *
 * 另外两条只有这里能测：保存走的是 `PUT /goal/{day}`（不是设置页那份 runtime.yaml
 * 大草稿），以及保存成功后要把看板的缓存一起失效——不然看板的标题会停在旧目标上。
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { wallDay } from '../../../core/boardWindow'

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) }
})

const calls: Record<string, unknown[][]> = { goal: [], saveGoal: [] }
const DAY = wallDay()
const OTHER = '2034-07-04'
/** 没写过的一行清单会被沿用（D-220），mock 里让这天返回 carried_from + 带勾的原文 */
const CARRIED = '2034-07-05'

vi.mock('../../../api', () => ({
  pipelineApi: new Proxy(
    {},
    {
      get:
        (_target, prop: string) =>
        (...args: unknown[]) => {
          if (prop in calls) calls[prop].push(args)
          if (prop === 'goal') {
            const asked = args[0]
            if (asked === CARRIED) {
              return Promise.resolve({
                goal_date: CARRIED,
                goal_text: '- [x] 捞 5 条进今日\n改完 3 个开头',
                updated_at: '2034-07-04T01:00:00+00:00',
                carried_from: OTHER,
              })
            }
            return Promise.resolve({
              goal_date: asked,
              // 历史那天保留它自己的勾（翻回 07-04 要看见当天做了什么）
              goal_text: asked === DAY ? '库里今天' : '- [x] 那天自己的条目',
              updated_at: null,
              carried_from: null,
            })
          }
          if (prop === 'saveGoal') {
            return Promise.resolve({ goal_date: args[0], goal_text: args[1], updated_at: 'x' })
          }
          return Promise.resolve([])
        },
    },
  ),
}))

import { GoalSection } from './GoalSection'

let qc: QueryClient
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={qc}>{children}</QueryClientProvider>
)

beforeEach(() => {
  for (const key of Object.keys(calls)) calls[key].length = 0
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})

describe('GoalSection 的接缝', () => {
  it('按选中的那天取目标', async () => {
    render(<GoalSection />, { wrapper })
    await waitFor(() => expect(calls.goal.length).toBeGreaterThan(0))
    expect(calls.goal[0][0]).toBe(DAY)
    expect(await screen.findByRole('textbox')).toHaveValue('库里今天')
  })

  it('没改过不发请求；改过发的是 saveGoal(day, text)', async () => {
    render(<GoalSection />, { wrapper })
    const box = await screen.findByRole('textbox')
    await waitFor(() => expect(box).toHaveValue('库里今天'))

    fireEvent.click(screen.getByText('settings.save'))
    expect(calls.saveGoal.length).toBe(0)

    fireEvent.change(box, { target: { value: '改成 30 条' } })
    fireEvent.click(screen.getByText('settings.save'))
    await waitFor(() => expect(calls.saveGoal.length).toBe(1))
    expect(calls.saveGoal[0]).toEqual([DAY, '改成 30 条'])
    expect(await screen.findByText('settings.goalSaved')).toBeInTheDocument()
  })

  it('换日期：上一天的草稿不跟过去，保存按钮回到未修改态', async () => {
    render(<GoalSection />, { wrapper })
    const box = await screen.findByRole('textbox')
    await waitFor(() => expect(box).toHaveValue('库里今天'))

    fireEvent.change(box, { target: { value: '这条只属于今天' } })
    fireEvent.change(screen.getByLabelText('settings.goalDay'), { target: { value: OTHER } })
    await waitFor(() => expect(box).toHaveValue('- [x] 那天自己的条目'))
    expect(calls.goal.some((a) => a[0] === OTHER)).toBe(true)

    fireEvent.click(screen.getByText('settings.save'))
    expect(calls.saveGoal.length).toBe(0)
  })

  it('没写过的那天沿用最近一份：洗掉勾、说明沿自哪天，且这不算"改过"（D-220）', async () => {
    render(<GoalSection />, { wrapper })
    const box = await screen.findByRole('textbox')
    await waitFor(() => expect(box).toHaveValue('库里今天'))

    fireEvent.change(screen.getByLabelText('settings.goalDay'), { target: { value: CARRIED } })
    // 洗过勾的版本：基线就是它，所以保存按钮仍是未点亮——不该一进来就"有未保存修改"
    await waitFor(() => expect(box).toHaveValue('- [ ] 捞 5 条进今日\n改完 3 个开头'))
    expect(await screen.findByText(/dashboard\.goalCarriedFrom/)).toBeInTheDocument()
    fireEvent.click(screen.getByText('settings.save'))
    expect(calls.saveGoal.length).toBe(0)
  })

  it('保存成功后把看板的缓存也失效（看板标题读的就是那份缓存）', async () => {
    const invalidated: string[][] = []
    const spy = vi.spyOn(qc, 'invalidateQueries').mockImplementation((arg) => {
      invalidated.push([JSON.stringify((arg as { queryKey?: unknown[] })?.queryKey ?? null)])
      return undefined as never
    })
    render(<GoalSection />, { wrapper })
    const box = await screen.findByRole('textbox')
    await waitFor(() => expect(box).toHaveValue('库里今天'))
    spy.mockClear()

    fireEvent.change(box, { target: { value: '新目标' } })
    fireEvent.click(screen.getByText('settings.save'))
    await waitFor(() => expect(calls.saveGoal.length).toBe(1))
    const keys = invalidated.map(([k]) => k)
    expect(keys).toContain('["daily-goal"]')
    expect(keys).toContain('["pipeline-board"]')
  })
})
