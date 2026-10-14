/**
 * 语法诊断横幅的判据。
 *
 * 为什么要有它：v0.36 之前 mdcore 有两本账——解析层的 `diagnostics`（哪些语法没建模）
 * 与渲染层的兜底记账（哪些块型没渲染分支）——**两本都在内核里，一个出口都没有**。
 * 于是"这稿子里有哪些东西我们没真正支持"这件事，用户只能反过来从"内容还在不在"
 * 猜。保内容是底线，但**保住了不等于说清楚了**。
 *
 * 这条横幅就是那半句"说清楚"。它平时**不该出现**（当前解析器把未建模集合守成空集），
 * 属于以后加语法时的护栏；所以第一判据是「没有诊断时不许占任何地方」。
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { DiagnosticsBanner } from './CanvasDiagnostics'
import { withDiagnostics } from './diagnosticsWire'

const labels = {
  summary: '{{count}} 处语法已保留原文，但未真正排版',
  expand: '展开',
  collapse: '收起',
  line: '行 {{line}}',
  times: '×{{count}}',
}

describe('没有诊断时不许出声', () => {
  it('空清单 → 整个横幅不渲染（不给正常稿件加噪声）', () => {
    const { container } = render(<DiagnosticsBanner items={[]} labels={labels} />)
    expect(container.firstChild).toBeNull()
    expect(screen.queryByTestId('mdstudio-diagnostics')).toBeNull()
  })
})

describe('有诊断时说清楚是哪几处', () => {
  const items = [
    { token: 'dl_open', count: 2, line: 4 },
    { token: 'render:rogue_block', count: 1, line: 9 },
  ]

  it('摘要里的计数是各项出现次数之和，不是"几类语法"', () => {
    render(<DiagnosticsBanner items={items} labels={labels} />)
    // 2 + 1 = 3 处。「写 2 类语法」会让人以为只坏了两行
    expect(screen.getByTestId('mdstudio-diagnostics').textContent).toContain('3 处语法')
  })

  it('默认折叠，展开后逐条列出 token 与行号', async () => {
    const user = userEvent.setup()
    render(<DiagnosticsBanner items={items} labels={labels} />)
    // 折叠时看不到明细
    expect(screen.queryByTestId('mdstudio-diagnostics-list')).toBeNull()

    await user.click(screen.getByRole('button', { name: '展开' }))
    const list = screen.getByTestId('mdstudio-diagnostics-list')
    expect(list.textContent).toContain('dl_open')
    // 内核的行号是 0 起（IRDiagnostic.line），但用户是在编辑器里数行的——编辑器从 1 数。
    // 所以横幅必须 +1，否则用户点过去会落在上一行。4 → 5。
    expect(list.textContent).toContain('行 5')
    expect(list.textContent).toContain('render:rogue_block')

    // 再点收起，按钮文案跟着换，明细消失
    await user.click(screen.getByRole('button', { name: '收起' }))
    expect(screen.queryByTestId('mdstudio-diagnostics-list')).toBeNull()
  })

  it('同一语法出现多次时合并成一条并标出次数（不刷一屏）', async () => {
    const user = userEvent.setup()
    render(
      <DiagnosticsBanner
        items={[{ token: 's', count: 7, line: 2 }]}
        labels={labels}
      />,
    )
    await user.click(screen.getByRole('button', { name: '展开' }))
    const list = screen.getByTestId('mdstudio-diagnostics-list')
    expect(list.querySelectorAll('li')).toHaveLength(1)
    expect(list.textContent).toContain('×7')
  })

  it('行号未知时不给行号（别显示"行 null"）', async () => {
    const user = userEvent.setup()
    render(<DiagnosticsBanner items={[{ token: 'html_block', count: 1, line: null }]} labels={labels} />)
    await user.click(screen.getByRole('button', { name: '展开' }))
    const list = screen.getByTestId('mdstudio-diagnostics-list')
    expect(list.textContent).not.toContain('null')
  })
})

/**
 * 接线本身的判据。
 *
 * 起因是一次变异：把 `collected.push(...parsed.diagnostics)` 删掉，**全绿**——
 * 因为今天没有任何一篇合法 markdown 能让渲染账非空，"漏收解析账"不会被副作用撞出来。
 * 与其把这条缝记成"已知覆盖不到"，不如把它抽成纯函数直接驱动（`diagnosticsWire.ts`）：
 * 让 render 回调往账里塞一笔渲染账，断言**两半都在**。
 */
describe('一次解析、两份账的接线', () => {
  it('解析账与渲染账都进同一份清单（渲染回调必须能同时看到两半）', () => {
    const seen: string[] = []
    withDiagnostics(
      '正文',
      (_ir, collected) => {
        // 模拟渲染层兜底记账
        collected.push({ token: 'render:rogue_block', count: 1, line: 3 })
        seen.push(...collected.map((d) => d.token))
      },
      // 注入一个解析账非空的假解析（真解析今天把未建模集合守成空集，撞不出这个错）
      () => ({ blocks: [], diagnostics: [{ token: 'dl_open', count: 2, line: 4 }] }),
    )
    expect(seen).toEqual(['dl_open', 'render:rogue_block'])
  })

  it('渲染回调抛错照旧往外抛（画布的 catch 负责清账，不在这里吞）', () => {
    expect(() =>
      withDiagnostics('正文', () => {
        throw new Error('boom')
      }),
    ).toThrow('boom')
  })
})
