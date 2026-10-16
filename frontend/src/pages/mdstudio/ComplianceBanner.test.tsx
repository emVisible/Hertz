/** 合规横幅判据测试（v0.37 P0-1）。

- ① 无发现时横幅完全不出现；
- ② 有发现时：词 / 类别 / 行号 / 数量 / 忽略按钮都正确；
- ③ 条目按词分组，数量汇总；
- ④ 忽略某词 → 该词从本次发现中消失。
*/

import { render, screen, act } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

// 测试环境清算：worker 侧的 react 是否是开发构建（导出 act）
// 若为生产构建，结果是 'undefined'——本测立即红，否则绿。
const require = createRequire(import.meta.url)
it('worker 侧 react.act 可见（测试环境：生产构建则此处报错）', () => {
  const React = require('react')
  expect(typeof React.act).toBe('function')
})

import { ComplianceBanner, type ComplianceLabels } from './ComplianceBanner'
import type { ComplianceFinding, ComplianceCategory } from '@hertz/mdcore'

const categoryLabel: Record<ComplianceCategory, string> = {
  violence: '暴恐',
  sexual: '色情低俗',
  political: '政治敏感',
  abuse: '低俗辱骂',
  spam: '低质灌水',
  metaphysics: '命理话术',
}

function makeLabels(): ComplianceLabels {
  return {
    summary: '发现 {{count}} 处敏感内容',
    expand: '展开',
    collapse: '收起',
    ignore: '忽略 {{term}}',
    category: categoryLabel,
    line: '行 {{line}}',
  }
}

const hit = (term: string, category: ComplianceCategory, line: number): ComplianceFinding => ({
  term,
  category,
  matched: term,
  line,
})

describe('ComplianceBanner', () => {
  it('① 无发现时完全不出现', () => {
    render(<ComplianceBanner findings={[]} labels={makeLabels()} onIgnore={() => {}} />)
    expect(document.querySelector('[data-testid="mdstudio-compliance"]')).toBeNull()
  })

  it('② 有发现时，各字段都正确显示', () => {
    render(
      <ComplianceBanner
        findings={[
          hit('改运', 'metaphysics', 2),
          hit('转运', 'metaphysics', 2),
          hit('福报', 'spam', 7),
        ]}
        labels={makeLabels()}
        onIgnore={() => {}}
      />,
    )
    // 条目默认折叠：先点「展开」再断言内容（与诊断横幅同纪律）
    act(() => screen.getByText('展开').click())
    // 摘要
    expect(screen.getByText('发现 3 处敏感内容')).toBeTruthy()
    // 展开后的条目：词、类别、行号、数量
    expect(screen.getByText('改运')).toBeTruthy()
    // 命理话术命中两处（改运 + 转运），低质灌水命中一次
    expect(screen.getAllByText('命理话术')).toHaveLength(2)
    expect(screen.getAllByText('低质灌水')).toHaveLength(1)
    expect(screen.getAllByText('行 3')).toHaveLength(2)
    expect(screen.getByText('忽略 改运')).toBeTruthy()
    expect(screen.getByText('福报')).toBeTruthy()
    expect(screen.getByText('行 8')).toBeTruthy()
    // 数量汇总（两次命中同词合为一行）
    expect(screen.queryByText('×2')).toBeNull()
  })

  it('③ 条目按词分组（两处命中同一词汇合并成一行）', () => {
    const findings = [
      hit('改运', 'metaphysics', 1),
      hit('改运', 'metaphysics', 4),
    ]
    render(
      <ComplianceBanner findings={findings} labels={makeLabels()} onIgnore={() => {}} />,
    )
    act(() => screen.getByText('展开').click())
    expect(screen.getByText('改运')).toBeTruthy()
    // 合并后只有一行，数量标注 ×2
    expect(screen.getByText('×2')).toBeTruthy()
    expect(screen.queryByText('转运')).toBeNull()
  })

  it('④ 忽略按钮调用 onIgnore（term 透传）', () => {
    const onIgnore = vi.fn()
    render(
      <ComplianceBanner
        findings={[hit('改运', 'metaphysics', 1)]}
        labels={makeLabels()}
        onIgnore={onIgnore}
      />,
    )
    act(() => screen.getByText('展开').click())
    act(() => screen.getByText('忽略 改运').click())
    expect(onIgnore).toHaveBeenCalledWith('改运')
  })

  it('⑤ 点击行号跳转（onJumpToLine 透传）', () => {
    const onJumpToLine = vi.fn()
    render(
      <ComplianceBanner
        findings={[hit('改运', 'metaphysics', 2)]}
        labels={makeLabels()}
        onIgnore={() => {}}
        onJumpToLine={onJumpToLine}
      />,
    )
    act(() => screen.getByText('展开').click())
    act(() => screen.getByText('行 3').click())
    expect(onJumpToLine).toHaveBeenCalledWith(2)
  })
})
