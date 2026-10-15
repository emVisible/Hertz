/**
 * 小红书正文的**阅读尺度**判据。
 *
 * 起因是一句人话：「现在这个字怎么这么小的」。一查不是错觉，是我们自己定的刻度偏小：
 *
 *   | 刻度        | 参考仓 | 我们(v0.36) |
 *   | 画布宽       | 1080  | 1080       |
 *   | 正文字号     | 36px  | 30px       |
 *   | 左右边距     | 96px  | 72px       |
 *   | 行高         | 1.75  | 1.55–1.6   |
 *   | 每行中文字数 | 888/36 ≈ 25 | 936/30 ≈ 31 |
 *
 * 三项一起偏：字更小、行里字更多、行距更紧。单独看每一项都"还行"，叠起来就是
 * 「又小又密」——这正是参考仓刻意避开的那一档。
 *
 * 所以判据不写"看起来大一点"，直接钉住参考仓那几个数：**字号、每行字数、行高**。
 * 其中「每行字数」是真正决定观感的那一项：它同时吃字号和边距，改任何一头都能动它。
 */
import { describe, expect, it } from 'vitest'

import { listThemes } from '../theme'
import { getTheme } from '../theme/index'
import { parseToIR } from '../ir/parseToIR'
import { XHS_PADDING, xhsCardSize, xhsCards } from './xhs'

/** 参考仓（`/Users/young/Code/xiaohongshu-text-layout`）的三个刻度 */
const REF = { fontSize: 36, padX: 96, lineHeight: 1.75, charsPerLine: 25 } as const

const xhsThemes = listThemes().filter((t) => t.platform === 'xhs')

describe('小红书正文字号：跟参考仓同一个量级', () => {
  it.each(xhsThemes.map((t) => t.id))('%s 的正文字号不小于参考仓的 36px', (id) => {
    const theme = getTheme(id)
    const px = parseFloat(theme.tokens.fontSize)
    // 判据是「不小于」而不是「等于」：设计器里用户可以自己调小，那是他的权利。
    // 但内置主题的出厂值不该比参考仓小——那是我们替用户做的决定。
    expect(px).toBeGreaterThanOrEqual(REF.fontSize)
  })

  it.each(xhsThemes.map((t) => t.id))('%s 的行高不小于参考仓的 1.75', (id) => {
    expect(parseFloat(getTheme(id).tokens.lineHeight)).toBeGreaterThanOrEqual(REF.lineHeight)
  })
})

describe('每行中文字数落在参考仓那一档（约 25 字）', () => {
  it('边距不小于参考仓的 96px（1080 坐标系下）', () => {
    expect(XHS_PADDING).toBeGreaterThanOrEqual(REF.padX)
  })

  it('正文列宽 ÷ 字号 落在 22–28 字之间', () => {
    const card = xhsCardSize('3:4')
    for (const ref of xhsThemes) {
      const theme = getTheme(ref.id)
      const fs = parseFloat(theme.tokens.fontSize)
      const column = card.width - XHS_PADDING * 2
      const chars = column / fs
      // 低于 22 是"每行太长，眼睛要从行尾扫回行首"；高于 28 是"每行太短，
      // 排版被零碎感切碎"。参考仓取 25 是个稳妥的中间值。
      expect(
        chars,
        `${theme.name}：列宽 ${column}px ÷ ${fs}px = ${chars.toFixed(1)} 字/行，越界了`,
      ).toBeGreaterThanOrEqual(22)
      expect(chars).toBeLessThanOrEqual(28)
    }
  })

  it('5 种比例都是 1080 宽，所以每行字数不随比例漂（换比例只换高）', () => {
    const widths = new Set(['3:4', '2:3', '9:16', '1:1', '4:3'].map((r) => xhsCardSize(r as never).width))
    expect([...widths]).toEqual([1080])
  })
})

describe('字号真的落到了卡片产物上（不是只改了 token）', () => {
  it.each(xhsThemes.map((t) => t.id))('%s 的正文页页壳字号 = 主题字号', (id) => {
    const result = xhsCards(parseToIR('# 标题\n\n正文一段。'), {
      theme: id,
      doc: globalThis.document,
      measurer: { fits: () => true },
    })
    // pages[0] 是独立封面，pages[1] 才是正文页
    const body = result.pages[1] ?? result.pages[0]
    expect(body.style.fontSize).toBe(getTheme(id).tokens.fontSize)
  })
})
