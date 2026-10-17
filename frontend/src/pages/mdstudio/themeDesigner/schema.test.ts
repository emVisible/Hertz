/** 设计器清单的守门判据（Phase 3）。
 *
 * 真正的风险不是"少一个变量不好看"，而是**加了 token 忘了补界面**——那会让
 * 设计器看起来完整、实际上有个变量永远改不了。所以这里对 mdcore 的
 * `ResolvedTokens` 键集做全集比对，而不是逐个 if/else 断言。
 */
import { describe, expect, it } from 'vitest'
import {
  CODE_BARS,
  CODE_THEMES,
  HEADING_STYLES,
  HR_STYLES,
  LIST_STYLES,
  QUOTE_STYLES,
  STRONG_STYLES,
  TABLE_STYLES,
  TOKEN_DEFAULTS,
} from '@hertz/mdcore'

import { ENUM_LABELS, TOKEN_DESCRIPTORS, TOKEN_SECTIONS } from './schema'

const ALL_TOKEN_KEYS = Object.keys(TOKEN_DEFAULTS).sort()

describe('token 清单覆盖全集', () => {
  it('清单键集 === mdcore ResolvedTokens 键集（不漏不重）', () => {
    const listed = TOKEN_DESCRIPTORS.map((d) => d.key).sort()
    expect(listed).toEqual(ALL_TOKEN_KEYS)
    expect(new Set(listed).size).toBe(listed.length)
  })

  it('分区 id 唯一，且每个分区都非空', () => {
    const ids = TOKEN_SECTIONS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const section of TOKEN_SECTIONS) {
      expect(section.tokens.length, `${section.id} 是空分区`).toBeGreaterThan(0)
    }
  })

  it('枚举型变量的候选值就是 mdcore 的常量表（不能各写一份）', () => {
    const pick = (key: string) => TOKEN_DESCRIPTORS.find((d) => d.key === key)
    expect(pick('headingStyle')?.options).toEqual(HEADING_STYLES)
    expect(pick('quoteStyle')?.options).toEqual(QUOTE_STYLES)
    expect(pick('strongStyle')?.options).toEqual(STRONG_STYLES)
    expect(pick('codeBar')?.options).toEqual(CODE_BARS)
    expect(pick('codeTheme')?.options).toEqual(CODE_THEMES)
    expect(pick('tableStyle')?.options).toEqual(TABLE_STYLES)
    expect(pick('listStyle')?.options).toEqual(LIST_STYLES)
    expect(pick('hrStyle')?.options).toEqual(HR_STYLES)
  })

  it('每个枚举候选都有中文标签（下拉里不能露出 left-bar 这种键名）', () => {
    // 只查"枚举型"：字族选择器的候选是字体栈本身，不是需要翻译的枚举键
    const ENUM_KEYS = new Set([
      'headingStyle',
      'quoteStyle',
      'strongStyle',
      'codeBar',
      'tableStyle',
      'listStyle',
      'hrStyle',
      'indent',
      'align',
      'measure',
      'codeTheme',
    ])
    for (const d of TOKEN_DESCRIPTORS) {
      if (!ENUM_KEYS.has(d.key)) continue
      for (const opt of d.options ?? []) {
        expect(ENUM_LABELS[opt], `${d.key} 的候选 "${opt}" 缺中文标签`).toBeTruthy()
      }
    }
  })

  it('派生标记只给主色族的四个（accentInk/soft/rule/hl）', () => {
    const derived = TOKEN_DESCRIPTORS.filter((d) => d.derived).map((d) => d.key).sort();
    expect(derived).toEqual(['accentInk', 'hl', 'rule', 'soft']);
  })

  it('每个变量都有中文名与说明（没有说明的变量用户不敢动）', () => {
    for (const d of TOKEN_DESCRIPTORS) {
      expect(d.label.trim().length, `${d.key} 缺中文名`).toBeGreaterThan(0)
      expect(d.hint.trim().length, `${d.key} 缺说明`).toBeGreaterThan(0)
    }
  })
})