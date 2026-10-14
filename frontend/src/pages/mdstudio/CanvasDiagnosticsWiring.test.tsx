/**
 * 页级判据：诊断横幅接在画布上之后，**正常稿件必须完全不出声**。
 *
 * 为什么要在页面这一层再钉一次：组件自己"空清单不渲染"是显然的，写对不难；
 * 真正的风险在接线——比如宿主忘了传文案、或者把清单当成了常量空数组，
 * 于是"没接线"和"接线了但没毛病"长得一模一样，没人发现。
 * 所以从 MdStudioPage 真的渲染一次，确认画布在正常稿子上是干净的。
 *
 * 已知覆盖边界（如实记下，不假装）：今天 mdcore 把未建模语法集合守成空集，
 * 所以**没有任何一篇合法 markdown 能让这条横幅亮起来**——端到端"有账 → 出横幅"
 * 这一段没有可驱动的输入。真正被验住的是两端：内核那两个出口会记账
 * （`mdcore/src/theme/dead-styles.test.ts`），横幅拿到账会显示（上面的组件判据）。
 * 中间这一段是纯赋值，等真有未建模语法时（W5）补一条端到端即可。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import '../../i18n'

const DOC: Record<string, unknown> = {
  id: 'l1',
  title: '正常稿',
  platform: 'wechat',
  theme_id: 'modi',
  source_md: [
    '# 标题',
    '',
    '正文一段。',
    '',
    '> 引用',
    '',
    '| a | b |',
    '| --- | --- |',
    '| 1 | 2 |',
  ].join('\n'),
  overrides: {},
  cover: { footer: '图文工坊' },
  created_at: '2026-10-14T00:00:00Z',
  updated_at: '2026-10-14T00:00:00Z',
}

vi.mock('../../api', () => ({
  layoutApi: {
    list: () =>
      Promise.resolve([
        { id: 'l1', title: '正常稿', platform: 'wechat', theme_id: 'modi', updated_at: '' },
      ]),
    get: () => Promise.resolve(DOC),
  },
  docsApi: { list: () => Promise.resolve([]) },
}))

import { MdStudioPage } from './MdStudioPage'

const wrapper = ({ children }: { children: ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

describe('画布在正常稿件上是干净的', () => {
  it('稿子里全是已支持语法 → 画布渲染出来了，诊断横幅没有出现', async () => {
    render(<MdStudioPage />, { wrapper })
    // 画布确实渲染了（不是"因为报错所以什么都没渲染"）
    await waitFor(() => expect(document.querySelector('.mdcore-doc')).toBeTruthy(), { timeout: 3000 })
    expect(document.querySelector('[data-testid="mdstudio-diagnostics"]')).toBeNull()
  })
})
