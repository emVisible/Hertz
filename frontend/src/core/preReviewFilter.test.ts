import { describe, expect, it, vi, afterEach } from 'vitest'

import { pipelineApi } from '../api'
import {
  DEFAULT_PRE_FILTERS,
  facetsQuery,
  preReviewQuery,
  type PreReviewFilters,
} from './preReviewFilter'

const fetched: string[] = []

/** 拦住 fetch，记下真实请求 URL（断言「参数进了请求」而不是只改了本地 state）。 */
function spyFetch() {
  fetched.length = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      fetched.push(String(input))
      return {
        ok: true,
        json: async () => [],
        text: async () => '[]',
      } as Response
    }),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const withFilters = (over: Partial<PreReviewFilters>): PreReviewFilters => ({
  ...DEFAULT_PRE_FILTERS,
  ...over,
})

describe('preReviewQuery：筛选轴 → 请求 query', () => {
  it('默认 = 全部：一条参数都不发（不发 theme=sentiment）', () => {
    expect(preReviewQuery(DEFAULT_PRE_FILTERS)).toEqual({})
    expect(DEFAULT_PRE_FILTERS.theme).toBe('all')
  })

  it('theme/quality/hasText 各自映射成后端的参数名与取值', () => {
    expect(preReviewQuery(withFilters({ theme: 'sentiment' }))).toEqual({ theme: 'sentiment' })
    expect(preReviewQuery(withFilters({ quality: 'standard' }))).toEqual({ quality: 'standard' })
    expect(preReviewQuery(withFilters({ hasText: 'yes' }))).toEqual({ has_text: 'true' })
    expect(preReviewQuery(withFilters({ hasText: 'no' }))).toEqual({ has_text: 'false' })
  })

  it('三轴可以叠加，未选的轴不出现', () => {
    expect(
      preReviewQuery(withFilters({ theme: 'sentiment', quality: 'strict', hasText: 'no' })),
    ).toEqual({ theme: 'sentiment', quality: 'strict', has_text: 'false' })
  })

  it('质量轴第四档 unfilled（分数没采到）也要进请求', () => {
    // 缺值不单列的话，「标准档 252」会被读成「其余都是低质量」——那是误导
    expect(preReviewQuery(withFilters({ quality: 'unfilled' }))).toEqual({ quality: 'unfilled' })
  })
})

// D-204 同类门禁形状：只把选择写进 state、没进请求，界面一样会「看起来在工作」。
describe('筛选参数真的进请求（不是只改本地 state）', () => {
  it('items() 带 theme / quality / has_text', async () => {
    spyFetch()
    await pipelineApi.items('discovered', 500, withFilters({ theme: 'sentiment', quality: 'loose', hasText: 'yes' }))
    const url = fetched[0]
    expect(url).toContain('/api/pipeline/items?')
    expect(url).toContain('theme=sentiment')
    expect(url).toContain('quality=loose')
    expect(url).toContain('has_text=true')
    expect(url).toContain('status=discovered')
    expect(url).toContain('limit=500')
  })

  it('items() 默认请求里没有 theme（默认全部，不偷偷预筛）', async () => {
    spyFetch()
    await pipelineApi.items('discovered', 500)
    expect(fetched[0]).not.toContain('theme=')
    expect(fetched[0]).not.toContain('has_text=')
    expect(fetched[0]).not.toContain('quality=')
  })

  it('items()/itemFacets() 真的把 quality=unfilled 发出去（列表与计数同一个轴）', async () => {
    spyFetch()
    const filters = withFilters({ quality: 'unfilled' })
    await pipelineApi.items('discovered', 500, filters)
    await pipelineApi.itemFacets('discovered', filters)
    expect(fetched[0]).toContain('quality=unfilled')
    expect(fetched[1]).toContain('quality=unfilled')
  })

  it('facets() 与列表走同一批参数：否则「命中 X」数的不是当前这一屏', async () => {
    spyFetch()
    const filters = withFilters({ theme: 'sentiment', quality: 'standard' })
    await pipelineApi.items('discovered', 500, filters)
    await pipelineApi.itemFacets('discovered', filters)
    expect(fetched[1]).toContain('/api/pipeline/items/facets?')
    expect(fetched[1]).toContain('theme=sentiment')
    expect(fetched[1]).toContain('quality=standard')
    // 两条请求的轴参数集合必须一模一样
    const axes = (u: string) => new URL(u).searchParams.get('theme') + '/' + new URL(u).searchParams.get('quality')
    expect(axes(fetched[1])).toEqual(axes(fetched[0]))
  })

  it('facetsQuery 不含 limit（分面是全量计数，不是当前一屏）', () => {
    expect(facetsQuery('discovered', withFilters({ theme: 'sentiment' }))).toContain('theme=sentiment')
    expect(facetsQuery('discovered', DEFAULT_PRE_FILTERS)).not.toContain('limit=')
    expect(facetsQuery('discovered', DEFAULT_PRE_FILTERS)).toContain('status=discovered')
  })
})
