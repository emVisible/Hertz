/**
 * 笔迹几何（Revel heritage）：预制图形生成折线点、RDP 抽稀、
 * 点到笔迹的距离（逐笔擦除命中检测）。纯函数、零依赖。
 */

import type { Stroke } from './types'

/** rect/ellipse/line 工具 → 折线点列（复用粉笔渲染与擦除管线）。 */
export function shapePoints(
  shape: 'rect' | 'ellipse' | 'line',
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): Array<{ x: number; y: number }> {
  if (shape === 'line') {
    return [
      { x: x1, y: y1 },
      { x: x2, y: y2 },
    ]
  }
  if (shape === 'rect') {
    const cx = (x1 + x2) / 2
    const cy = (y1 + y2) / 2
    const w = Math.abs(x2 - x1) / 2
    const h = Math.abs(y2 - y1) / 2
    return [
      { x: cx - w, y: cy - h },
      { x: cx + w, y: cy - h },
      { x: cx + w, y: cy + h },
      { x: cx - w, y: cy + h },
      { x: cx - w, y: cy - h },
    ]
  }
  // ellipse: 64 段折线
  const cx = (x1 + x2) / 2
  const cy = (y1 + y2) / 2
  const rx = Math.max(Math.abs(x2 - x1) / 2, 1)
  const ry = Math.max(Math.abs(y2 - y1) / 2, 1)
  const pts: Array<{ x: number; y: number }> = []
  const N = 64
  for (let i = 0; i <= N; i += 1) {
    const t = (i / N) * Math.PI * 2
    pts.push({ x: cx + Math.cos(t) * rx, y: cy + Math.sin(t) * ry })
  }
  return pts
}

/** 点到折线的最小距离（px）。 */
export function distanceToStroke(stroke: Stroke, x: number, y: number): number {
  const pts = stroke.points
  if (pts.length === 0) return Infinity
  if (pts.length === 1) return Math.hypot(pts[0].x - x, pts[0].y - y)
  let best = Infinity
  for (let i = 1; i < pts.length; i += 1) {
    const ax = pts[i - 1].x
    const ay = pts[i - 1].y
    const bx = pts[i].x
    const by = pts[i].y
    const abx = bx - ax
    const aby = by - ay
    const t = Math.max(0, Math.min(1, ((x - ax) * abx + (y - ay) * aby) / Math.max(abx * abx + aby * aby, 1e-12)))
    const cx = ax + abx * t
    const cy = ay + aby * t
    const d = Math.hypot(cx - x, cy - y)
    if (d < best) best = d
  }
  return best
}

/** Ramer–Douglas–Peucker 抽稀：笔迹点过多时保持形状、砍掉冗余（AXIOM §7.2）。 */
export function simplifyStroke(points: Array<{ x: number; y: number }>, epsilon = 2): Array<{ x: number; y: number }> {
  if (points.length <= 2) return points
  let maxDist = 0
  let index = 0
  const a = points[0]
  const b = points[points.length - 1]
  const abx = b.x - a.x
  const aby = b.y - a.y
  const len2 = abx * abx + aby * aby
  for (let i = 1; i < points.length - 1; i += 1) {
    const d = len2 === 0
      ? Math.hypot(points[i].x - a.x, points[i].y - a.y)
      : Math.abs((points[i].x - a.x) * aby - (points[i].y - a.y) * abx) / Math.sqrt(len2)
    if (d > maxDist) {
      maxDist = d
      index = i
    }
  }
  if (maxDist > epsilon) {
    const left = simplifyStroke(points.slice(0, index + 1), epsilon)
    const right = simplifyStroke(points.slice(index), epsilon)
    return [...left.slice(0, -1), ...right]
  }
  return [a, b]
}
