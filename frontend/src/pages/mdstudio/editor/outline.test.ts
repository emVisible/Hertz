/** 大纲与行号换算的判据（Phase 4）。 */
import { describe, expect, it } from 'vitest'
import { parseToIR } from '@hertz/mdcore'

import { blockIndexAtLine, buildOutline, outlineIndentLevel } from './outline'

const MD = ['# 标题一', '', '正文甲', '', '## 小节', '', '正文乙', '', '### 更深', '', '正文丙'].join('\n')

describe('大纲', () => {
  it('只收标题、只到 3 级，行号来自 IR', () => {
    const outline = buildOutline(parseToIR(MD))
    expect(outline.map((i) => `${i.level}:${i.text}@${i.line}`)).toEqual([
      '1:标题一@0',
      '2:小节@4',
      '3:更深@8',
    ])
  })

  it('4 级标题不进大纲（排版稿里是噪声）', () => {
    const outline = buildOutline(parseToIR('# a\n\n#### b\n\n## c\n'))
    expect(outline.map((i) => i.text)).toEqual(['a', 'c'])
  })

  it('标题行号可以真的跳回去：跳过去那一行就是标题行', () => {
    const lines = MD.split('\n')
    for (const item of buildOutline(parseToIR(MD))) {
      expect(lines[item.line]).toBe(`#${item.level === 1 ? '' : '#'.repeat(item.level - 1)} ${item.text}`)
    }
  })

  it('空标题被滤掉（否则大纲上会有一条点不动的空行）', () => {
    expect(buildOutline(parseToIR('#  \n\n## 有内容的\n'))).toHaveLength(1)
  })

  it('缩进档位按层级递增', () => {
    const [h1, h2, h3] = buildOutline(parseToIR(MD))
    expect(outlineIndentLevel(h1)).toBe(0)
    expect(outlineIndentLevel(h2)).toBe(1)
    expect(outlineIndentLevel(h3)).toBe(2)
  })
})

describe('光标行 → 画布块', () => {
  const blocks = parseToIR(MD)

  it('正文行落在对应段落块上', () => {
    expect(blockIndexAtLine(blocks, 2)).toBe(1) // 「正文甲」
    expect(blockIndexAtLine(blocks, 6)).toBe(3) // 「正文乙」
  })

  it('标题行选窄的那块：标题块而不是它下面的正文块', () => {
    const headingIndex = blocks.findIndex((b) => b.type === 'heading')
    expect(blockIndexAtLine(blocks, 0)).toBe(headingIndex)
  })

  it('空行归它上邻的块（markdown-it 的行区间含尾行，块间空行算前一块的）', () => {
    const headingIndex = blocks.findIndex((b) => b.type === 'heading')
    expect(blockIndexAtLine(blocks, 1)).toBe(headingIndex) // 「# 标题一」后的空行
    expect(blockIndexAtLine(blocks, 3)).toBe(1) // 「正文甲」后的空行
  })

  it('落在所有区间之外的行回落到最近的上一块（光标移出正文时高亮不该消失）', () => {
    expect(blockIndexAtLine(blocks, 999)).toBe(5) // 文档最后一段
  })

  it('文档最开头之前无处可落，返回 null（上层不做事，而不是高亮第 0 块）', () => {
    const ir = parseToIR('正文\n')
    expect(blockIndexAtLine(ir, -1)).toBeNull()
  })

  it('空文档返回 null', () => {
    expect(blockIndexAtLine(parseToIR(''), 0)).toBeNull()
  })
})