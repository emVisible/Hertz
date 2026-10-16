/** 命理扫描器判据测试（v0.37 P0-1）——成对变异：删掉对 BUILT_IN 的装载或
把 METAPHYSICS_LIST 清空，都能把本文件里所有命中断言打红。 */

import { describe, expect, it } from 'vitest'
import {
  BUILT_IN,
  GENERAL_LISTS,
  METAPHYSICS_LIST,
  type ComplianceWordlist,
} from './wordlists'
import { scanCompliance } from './scan'
import type { ComplianceFinding } from './types'

function words(list: ComplianceWordlist): string[] {
  return list.terms.map((t) => (typeof t === 'string' ? t : t.term))
}

describe('scanCompliance', () => {
  // 判据①：清空词表装载 → 所有命中断言全红
  it('空词表装载时命中断言全红（删词表才不报）', () => {
    const haystack = '改运 转运 福报 网赚 台独'
    expect(scanCompliance(haystack)).toHaveLength(5)
    expect(scanCompliance(haystack, { wordlists: [] })).toHaveLength(0)
  })

  // 判据②：命理专属词表每词单测红
  it('METAPHYSICS_LIST 每词单测红', () => {
    for (const term of words(METAPHYSICS_LIST)) {
      const hits = scanCompliance(
        `正文里出现了 ${term} 这种话术。`,
        { wordlists: [METAPHYSICS_LIST] },
      )
      expect(hits, `term: ${term}`).toHaveLength(1)
      expect(hits[0].term).toBe(term)
      expect(hits[0].category).toBe('metaphysics')
    }
  })

  // 判据③：白名单豁免后同词不再报
  it('白名单豁免后同词不再报', () => {
    const text = '他说这个法术能改运。'
    expect(
      scanCompliance(text, { whitelist: ['改运'] }),
    ).toHaveLength(0)
  })

  // 判据④：清楚文本无发现，横幅完全不出现
  it('清楚文本无发现，横幅不出现', () => {
    expect(scanCompliance('这是一篇合法的命理文化稿。')).toHaveLength(0)
  })

  // 代码块不误报
  it('代码块内词不会被命中', () => {
    const text = '```\n今天讲改运和通灵的案例\n```\n正文开始 福报'
    const findings = scanCompliance(text)
    expect(findings.map((f) => f.term)).toEqual(['福报'])
    expect(findings.map((f) => f.line)).toEqual([3])
  })

  // 间隔符逃逸写法统一命中（5 种逃逸写法 + 2 个正常写法全部被命中）
  it('间隔符逃逸写法统一命中', () => {
    const text = '改 运（改·运）改*运 改_运 改-运 改运 改运'
    const findings = scanCompliance(text)
    expect(findings).toHaveLength(7)
    expect(findings.every((f) => f.term === '改运')).toBe(true)
  })

  // 别名（拼音首字母）命中
  it('别名（拼音首字母）命中', () => {
    const findings = scanCompliance(
      '他对我们说了个 gy 改运的招数',
      { wordlists: [METAPHYSICS_LIST] },
    )
    expect(findings.some((f) => f.term === '改运')).toBe(true)
  })

  // 行号为源码 0 起行
  it('行号为源码 0 起行', () => {
    const text = '头行\n改运\n三行\n转运'
    const findings = scanCompliance(text)
    expect(findings.map((f) => f.line)).toEqual([1, 3])
  })

  // 通用 5 类类别正确
  it('通用 5 类类别正确', () => {
    const texts: Record<string, string> = {
      violence: '匕首 炸弹',
      sexual: '黄色 情色',
      political: '台独 藏独',
      abuse: '傻逼 混蛋',
      spam: '网赚 静态',
    }
    for (const [cat, text] of Object.entries(texts)) {
      const findings = scanCompliance(text, { wordlists: GENERAL_LISTS })
      expect(findings, `category: ${cat}`).toHaveLength(2)
      expect(findings.every((f: ComplianceFinding) => f.category === cat)).toBe(true)
    }
  })
})
