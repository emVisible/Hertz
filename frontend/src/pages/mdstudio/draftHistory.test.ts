/**
 * 文档级撤销/重做的判据。
 *
 * 守三件用户实际会抱怨的事：
 * ①**样式改动撤得回**（CodeMirror 只管文字，拖个滑杆就撤不回来，用户于是不敢动）；
 * ②**连续拖同一个滑杆不会把撤销栈冲垮**（合并同类，否则按一次撤不回本步）；
 * ③**到底了就不给一个不动的按钮**（假装能按的撤销比没有更伤信任）。
 */
import { describe, expect, it } from 'vitest'

import {
  canRedo,
  canUndo,
  createHistory,
  pushState,
  redo,
  undo,
  type DraftHistory,
} from './draftHistory'

interface Doc {
  source_md: string
  theme_id: string
  fontSize: string
}

const base: Doc = { source_md: '# 甲', theme_id: 'modi', fontSize: '16px' }

describe('撤销：样式改得回去', () => {
  it('换主题 → 撤销回到原主题', () => {
    let h: DraftHistory<Doc> = createHistory(base)
    h = pushState(h, { ...base, theme_id: 'taoyao' }, ['theme_id'])
    expect(canUndo(h)).toBe(true)
    h = undo(h)
    expect(h.past[h.past.length - 1].state.theme_id).toBe('modi')
  })

  it('撤销后能重做回来（不是单向的）', () => {
    let h: DraftHistory<Doc> = createHistory(base)
    h = pushState(h, { ...base, fontSize: '20px' }, ['fontSize'])
    h = undo(h)
    expect(canRedo(h)).toBe(true)
    h = redo(h)
    expect(h.past[h.past.length - 1].state.fontSize).toBe('20px')
  })

  it('新的改动会清空重做栈（这才是编辑器该有的语义）', () => {
    let h: DraftHistory<Doc> = createHistory(base)
    h = pushState(h, { ...base, fontSize: '20px' }, ['fontSize'])
    h = undo(h)
    expect(canRedo(h)).toBe(true)
    h = pushState(h, { ...base, theme_id: 'wanfeng' }, ['theme_id'])
    expect(canRedo(h)).toBe(false)
  })
});

describe('合并同类：拖滑杆不能把撤销栈冲垮', () => {
  it('窗口内连续改同一个字段只占一格（否则按一次撤不回本步）', () => {
    let h: DraftHistory<Doc> = createHistory(base)
    const t0 = 1_000_000
    // 模拟一次拖动产生的 50 个 patch
    for (let i = 1; i <= 50; i += 1) {
      h = pushState(h, { ...base, fontSize: `${i}px` }, ['fontSize'], t0 + i * 16)
    }
    expect(h.past.length).toBe(2)
    h = undo(h)
    expect(h.past[h.past.length - 1].state.fontSize).toBe('16px')
  })

  it('改的是不同字段就不合并（那是两步，得能分两次撤）', () => {
    let h: DraftHistory<Doc> = createHistory(base)
    const t0 = 1_000_000
    h = pushState(h, { ...base, fontSize: '18px' }, ['fontSize'], t0 + 16)
    h = pushState(h, { ...base, fontSize: '18px', theme_id: 'taoyao' }, ['theme_id'], t0 + 32)
    expect(h.past.length).toBe(3)
  })

  it('超过合并窗口的同类改动仍然分开（停一停再拖是另一次操作）', () => {
    let h: DraftHistory<Doc> = createHistory(base)
    const t0 = 1_000_000
    h = pushState(h, { ...base, fontSize: '18px' }, ['fontSize'], t0 + 16)
    h = pushState(h, { ...base, fontSize: '20px' }, ['fontSize'], t0 + 16 + 5_000)
    expect(h.past.length).toBe(3)
  })

  it('栈有上限（长时间编辑不能把内存吃光）', () => {
    let h: DraftHistory<Doc> = createHistory(base)
    for (let i = 0; i < 200; i += 1) {
      h = pushState(h, { ...base, source_md: `# ${i}` }, ['source_md'], 1_000_000 + i * 5_000)
    }
    expect(h.past.length).toBeLessThanOrEqual(60)
  })
})

describe('到底了就不假装能撤', () => {
  it('初始状态按撤销：状态不变，但 canUndo 为假（按钮可以置灰）', () => {
    const h = createHistory(base)
    expect(canUndo(h)).toBe(false)
    const after = undo(h)
    expect(after.past.length).toBe(1)
  })

  it('没有可重做时 canRedo 为假', () => {
    const h = createHistory(base)
    expect(canRedo(h)).toBe(false)
  })
})
