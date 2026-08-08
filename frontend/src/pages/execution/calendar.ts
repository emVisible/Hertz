/** 内容日历纯函数（AXIOM §1.2 单一真相源）：月网格计算与日期格式化。 */

export interface DayCell {
  /** YYYY-MM-DD（本地日期语义，与后端 from/to 一致） */
  iso: string
  day: number
  inMonth: boolean
}

/** 本地日期 → YYYY-MM-DD */
export function toLocalDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** UTC ISO 时间串 → 本地 YYYY-MM-DD（日历落位用本地日） */
export function toLocalDateFromIso(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return toLocalDate(d)
}

/** 月网格：周一开头，补齐前后月到整 6 周（42 格，日历稳定不跳行） */
export function monthGrid(year: number, month: number): DayCell[] {
  const first = new Date(year, month, 1)
  const startOffset = (first.getDay() + 6) % 7 // 周一 = 0
  const gridStart = new Date(year, month, 1 - startOffset)
  const cells: DayCell[] = []
  for (let i = 0; i < 42; i += 1) {
    const d = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i)
    cells.push({ iso: toLocalDate(d), day: d.getDate(), inMonth: d.getMonth() === month })
  }
  return cells
}

/** 月标签（"2026-08"）与前后月切换 */
export function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const d = new Date(year, month + delta, 1)
  return { year: d.getFullYear(), month: d.getMonth() }
}
