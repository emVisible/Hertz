/** Monoline 模式库数据完整性（与 backend/monoline/templates/*.j2 对齐）。 */

import { describe, expect, it } from 'vitest'

import { MODE_COUNT, MODE_GROUPS, MODES } from './modes'

describe('monoline modes catalog', () => {
  it('has 28 scene kinds in 5 groups', () => {
    expect(MODE_COUNT).toBe(28)
    expect(MODE_GROUPS).toHaveLength(5)
    expect(Object.keys(MODES)).toHaveLength(28)
  })

  it('every mode has zh/desc/glyph', () => {
    for (const m of Object.values(MODES)) {
      expect(m.kind).toBeTruthy()
      expect(m.zh).toBeTruthy()
      expect(m.desc).toBeTruthy()
      expect(m.glyph).toContain('<')
    }
  })

  it('covers text/data/structure/media anchors', () => {
    for (const k of ['title', 'statement', 'quote', 'flow', 'funnel', 'trend', 'image', 'showcase', 'matrix']) {
      expect(MODES[k]).toBeDefined()
    }
  })
})
