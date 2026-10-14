/**
 * 编辑器侧的大纲与联动映射（Phase 4）。
 *
 * 这一层刻意写成**纯函数**，因为它是"编辑器 ↔ 画布"两个方向联动的唯一真相源：
 * ①光标在第几行 → 画布该高亮哪一块；②大纲某一项 → 光标跳到第几行。
 * 两边都是行号换算，逻辑薄但错位很难发现（表现为"点标题跳到隔壁段落"），
 * 所以给它独立判据，而不是塞进组件里靠肉眼验。
 */
import type { IRBlock } from '@hertz/mdcore'

export interface OutlineItem {
  /** 标题文本 */
  text: string
  level: number
  /** 标题所在行（0 起，与 markdown-it token.map 一致） */
  line: number
}

/**
 * 从 IR 取大纲。
 *
 * 为什么用 IR 而不是重新扫一遍 Markdown：标题的**行号**在 IR 里已经是解析产物
 * （`token.map`），再扫一遍 Markdown 就有了第二套行号——两套行号迟早会漂。
 * 只收 1~3 级：4 级以下在排版稿里通常是噪声。
 */
export function buildOutline(blocks: IRBlock[], maxLevel = 3): OutlineItem[] {
  return blocks
    .filter((b): b is Extract<IRBlock, { type: 'heading' }> => b.type === 'heading' && b.level <= maxLevel)
    .filter((b) => b.line !== null)
    .map((b) => ({ text: b.children.map((c) => ('text' in c ? String((c as { text?: string }).text ?? '') : '')).join(''), level: b.level, line: b.line![0] }))
    .filter((item) => item.text.trim() !== '')
}

/**
 * 行号 → IR 块序号。
 *
 * 取「包含该行、且最窄」的那一块：标题块和它内部的段落块都含第 N 行时，选窄的
 * （标题），否则光标落在任何一行标题上，高亮的都是整个章节。
 * 一行都不含（比如空行）就回落到最近的上一块——静默不返回会让光标移出正文后
 * 画布高亮消失，用户以为联动坏了。
 */
export function blockIndexAtLine(blocks: IRBlock[], line: number): number | null {
  let bestIndex: number | null = null
  let bestSpan = Number.POSITIVE_INFINITY
  let nearestBefore: number | null = null
  blocks.forEach((block, index) => {
    if (!block.line) return
    const [start, end] = block.line
    if (line >= start && line <= end) {
      const span = end - start
      if (span < bestSpan) {
        bestSpan = span
        bestIndex = index
      }
    }
    if (start <= line) nearestBefore = index
  })
  if (bestIndex !== null) return bestIndex
  return nearestBefore
}

/** 大纲项的缩进档位：h1 不缩进，每深一级多一档 */
export function outlineIndentLevel(item: OutlineItem): number {
  return Math.max(0, item.level - 1)
}