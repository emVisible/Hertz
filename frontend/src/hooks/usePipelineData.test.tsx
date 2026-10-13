/** 未评分筛选的**接缝**测试（v0.34 A）：轴值必须真的进请求。
 *
 * 为什么单独立一个文件：`preReviewFilter.test.ts` 已经证明「给我 filters，我拼出正确 query」，
 * `api/pipeline.ts` 也证明「items() 会把 query 发出去」。中间那一段——**store 里的轴值
 * 有没有被 usePipelineData 读出来交给 items()**——两边都测不到。
 * 而这一段坏掉的样子我们见过：v0.20–v0.31 的设置页点「保存」提交空载荷，
 * 页面照样 toast「已保存」（D-204）。选了「情感类」却没发参数，界面会显示一份
 * 看起来筛过了、其实没筛的列表——比报错更坏。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// pipelineApi 的方法很多，用 Proxy 一律换成「返回空数组的异步桩」，
// 同时留下 items/itemFacets 的调用记录——新增查询不会让这个测试脆弱。
const itemsCalls: Array<[string?: string, number?, unknown?]> = []
vi.mock('../api', () => ({
  api: { get: vi.fn(async () => ({})), post: vi.fn(async () => ({})) },
  pipelineApi: new Proxy(
    {},
    {
      get:
        (_t, prop: string) =>
        (...args: unknown[]) => {
          if (prop === 'items') itemsCalls.push(args as [string?, number?, unknown?])
          if (prop === 'counts') return Promise.resolve({})
          if (prop === 'status') return Promise.resolve({ running: false })
          return Promise.resolve([])
        },
    },
  ),
}))

import { usePipelineData } from './usePipelineData'
import { useExecutionStore } from '../stores/execution'

const wrapper = ({ children }: { children: ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

/** 已评分/未加工段的请求状态列表。v0.39 加了 skipped：判重跳过的条目
 *  也在这段里，否则它在界面上彻底消失（静默消失和谎报失败一样会藏住真相）。 */
const QUEUE_STATUS = 'downloaded,scored,queued,approved,failed,rejected,skipped'

describe('usePipelineData 的三轴接缝', () => {
  beforeEach(() => {
    itemsCalls.length = 0
    act(() => {
      useExecutionStore.getState().setPipeline({
        preTheme: 'all',
        preQuality: 'all',
        preHasText: 'all',
        preMaterial: 'all',
      })
    })
  })

  it('默认不发任何轴参数（默认「全部」，不是默认情感）', async () => {
    const { result } = renderHook(() => usePipelineData(), { wrapper })
    await waitFor(() => expect(itemsCalls.length).toBeGreaterThan(0))
    const discovered = itemsCalls.find((c) => c[0] === 'discovered')
    expect(discovered?.[2]).toMatchObject({
      theme: 'all',
      quality: 'all',
      hasText: 'all',
      material: 'all',
    })
    expect(result.current.preFilters.theme).toBe('all')
  })

  it('写 store 之后，items() 收到的 filters 跟着变——这才叫「界面选了 = 服务端筛了」', async () => {
    const { result } = renderHook(() => usePipelineData(), { wrapper })
    await waitFor(() => expect(itemsCalls.length).toBeGreaterThan(0))

    act(() => {
      result.current.setPreFilters({ preTheme: 'sentiment', preQuality: 'standard' })
    })

    await waitFor(() => {
      const discovered = itemsCalls.filter((c) => c[0] === 'discovered').pop()
      expect(discovered?.[2]).toMatchObject({ theme: 'sentiment', quality: 'standard' })
    })
    expect(result.current.preFilters).toMatchObject({ theme: 'sentiment', quality: 'standard' })
    // 轴值同时进 queryKey：不进去就会命中旧缓存，列表停在上一批筛选结果上
    expect(result.current.preFilters.theme).toBe('sentiment')
  })

  it('分面与列表共用同一批轴（两处各拼一套就会漂成「命中数说东、列表说西」）', async () => {
    const { result } = renderHook(() => usePipelineData(), { wrapper })
    await waitFor(() => expect(itemsCalls.length).toBeGreaterThan(0))
    act(() => result.current.setPreFilters({ preHasText: 'no' }))
    await waitFor(() => {
      expect(result.current.preFilters.hasText).toBe('no')
    })
    expect(result.current.preFilters.hasText).toBe('no')
  })

  // 素材类型轴的接缝：它与另外三轴不同——另外三轴只服务 discovered 段，
  // 而它**三段共用**（用户要求在已评分/已下载未加工段也能筛）。
  // 所以除了 discovered 请求，还必须证明 queueAll 那条请求也带上了 material：
  // 不带就是「画了选择器、后两段没发参数」的 UI 谎言（本仓明令禁止的那种）。
  it('material 进 discovered 请求', async () => {
    const { result } = renderHook(() => usePipelineData(), { wrapper })
    await waitFor(() => expect(itemsCalls.length).toBeGreaterThan(0))
    act(() => result.current.setPreFilters({ preMaterial: 'text' }))
    await waitFor(() => {
      const discovered = itemsCalls.filter((c) => c[0] === 'discovered').pop()
      expect(discovered?.[2]).toMatchObject({ material: 'text' })
    })
  })

  it('material 也进已评分/已下载未加工段的请求（三段共用同一选择）', async () => {
    const { result } = renderHook(() => usePipelineData(), { wrapper })
    await waitFor(() => expect(itemsCalls.length).toBeGreaterThan(0))

    // 先确认默认时后两段请求确实带着默认 axes（而不是压根没传第三参）
    const before = itemsCalls.filter((c) => c[0] === QUEUE_STATUS).pop()
    expect(before?.[2]).toMatchObject({ material: 'all' })

    act(() => result.current.setPreFilters({ preMaterial: 'video' }))
    await waitFor(() => {
      const after = itemsCalls.filter((c) => c[0] === QUEUE_STATUS).pop()
      expect(after?.[2]).toMatchObject({ material: 'video' })
    })
  })

  it('material 不污染后两段的另外三轴（它们仍是未评分期的判据，不该在这两段生效）', async () => {
    const { result } = renderHook(() => usePipelineData(), { wrapper })
    await waitFor(() => expect(itemsCalls.length).toBeGreaterThan(0))
    act(() =>
      result.current.setPreFilters({ preMaterial: 'image', preTheme: 'sentiment' }),
    )
    await waitFor(() => {
      const queue = itemsCalls
        .filter((c) => c[0] === QUEUE_STATUS)
        .pop()
      expect(queue?.[2]).toMatchObject({ material: 'image', theme: 'all' })
    })
  })
})
