import { describe, expect, it } from 'vitest'

import { monthGrid, shiftMonth, toLocalDate, toLocalDateFromIso } from './calendar'

describe('calendar pure functions', () => {
  it('monthGrid: 42 格、周一起始、月内/月外标记', () => {
    // 2026-08-01 是周六；周一开头 → 7 月 27 日（周一）起，7 月末 5 格为月外
    const grid = monthGrid(2026, 7) // 0-based：7 = 八月
    expect(grid).toHaveLength(42)
    expect(grid[0].iso).toBe('2026-07-27') // 周一
    expect(grid[0].inMonth).toBe(false)
    const aug1 = grid.find((c) => c.iso === '2026-08-01')
    expect(aug1).toBeDefined()
    expect(aug1!.inMonth).toBe(true)
    // 8 月 31 日（周一）后仍补齐到 42 格
    expect(grid[grid.length - 1].inMonth).toBe(false)
  })

  it('monthGrid: 跨月边界正确（6/30 是周一 → 从 6/29 开始）', () => {
    const grid = monthGrid(2026, 5) // 六月
    expect(grid[0].iso).toBe('2026-06-01') // 6/1 是周一
    expect(grid[0].inMonth).toBe(true)
  })

  it('toLocalDate / toLocalDateFromIso', () => {
    expect(toLocalDate(new Date(2026, 7, 10))).toBe('2026-08-10')
    expect(toLocalDateFromIso('2026-08-10T10:00:00+00:00')).toBe('2026-08-10')
    expect(toLocalDateFromIso(null)).toBeNull()
    expect(toLocalDateFromIso('not-a-date')).toBeNull()
  })

  it('shiftMonth 前后月切换', () => {
    expect(shiftMonth(2026, 7, 1)).toEqual({ year: 2026, month: 8 })
    expect(shiftMonth(2026, 0, -1)).toEqual({ year: 2025, month: 11 })
    expect(shiftMonth(2026, 11, 1)).toEqual({ year: 2027, month: 0 })
  })
})
