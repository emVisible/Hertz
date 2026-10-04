/** `setFocus` 的接缝测试（v0.34 D-218）：今日关注只有一个界面写点，且它一处失效两边都跟上。
 *
 * 为什么值得单独立一条：看板和流水线的三个列表现在都调 `p.setFocus`。写点收成一处之后，
 * 这一处必须真的①把 patch 原样发给后端、②同时失效看板那份缓存与流水线那几份阶段缓存。
 * 少了 ② 的任何一边，症状都是「点完没反应」或「回看板还是旧的」——那种缺陷不会报错。
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) }
})

const setFocusCalls: unknown[][] = []
vi.mock('../api', () => ({
  pipelineApi: new Proxy(
    {},
    {
      get:
        (_t, prop: string) =>
        (...args: unknown[]) => {
          if (prop === 'setFocus') {
            setFocusCalls.push(args)
            return Promise.resolve({ id: args[0], ...(args[1] as object) })
          }
          return Promise.resolve([])
        },
    },
  ),
}))

import { usePipelineActions } from './usePipelineActions'

let qc: QueryClient
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={qc}>{children}</QueryClientProvider>
)

const item = { id: 'item-1', title: 'AITA by skipping the funeral' } as never
const invalidated: string[] = []

beforeEach(() => {
  setFocusCalls.length = 0
  invalidated.length = 0
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const spy = vi.spyOn(qc, 'invalidateQueries')
  spy.mockImplementation((arg) => {
    invalidated.push(JSON.stringify((arg as { queryKey?: unknown[] })?.queryKey ?? null))
    return Promise.resolve()
  })
})

describe('usePipelineActions.setFocus', () => {
  it('把 patch 原样发给自己那一个端点（不做二次加工）', async () => {
    const { result } = renderHook(
      () => usePipelineActions({ discoveryAll: [], queueAll: [], stagePublished: [], limit: 50 }),
      { wrapper },
    )
    await act(async () => {
      await result.current.setFocus(item, { focus_date: '2026-10-04' })
    })
    expect(setFocusCalls).toEqual([['item-1', { focus_date: '2026-10-04' }]])
  })

  it('一次写入同时失效看板与流水线两份缓存（否则两边各有一边停在旧数据上）', async () => {
    const { result } = renderHook(
      () => usePipelineActions({ discoveryAll: [], queueAll: [], stagePublished: [], limit: 50 }),
      { wrapper },
    )
    await act(async () => {
      await result.current.setFocus(item, { focus_note: '结尾加一句反转' })
    })
    expect(invalidated).toContain('["pipeline-board"]')
    expect(invalidated).toContain('["pipeline-stage"]')
    expect(invalidated).toContain('["pipeline-counts"]')
    // 对照组：这条判据不是恒真——它没失效的键必须确实没出现在清单里
    expect(invalidated).not.toContain('["pipeline-calendar"]')
  })
})
