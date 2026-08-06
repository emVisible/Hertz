/**
 * 粉笔质感（Revel heritage）：种子随机 + 多道锯齿叠加，营造黑板粉笔感。
 * 抖动是确定性的（同一笔迹每帧一致，不闪烁），且每段独立播种。
 */

export interface ChalkSeed {
  roughness: number
  gap: number
  width: number
  opacity: number
}

export function chalkSeed(seed: number): ChalkSeed {
  let s = seed * 9301 + 49297
  const rand = (): number => {
    s = (s * 9301 + 49297) % 233280
    return s / 233280
  }
  return {
    roughness: 0.6 + rand() * 1.2,
    gap: 1.5 + rand() * 2.5,
    width: 1.6 + rand() * 1.2,
    opacity: 0.5 + rand() * 0.4,
  }
}

/** 确定性伪随机（LCG）：同 seed 永远同序列。 */
function seededRand(seed: number): () => number {
  let s = (seed * 9301 + 49297) % 233280
  return () => {
    s = (s * 9301 + 49297) % 233280
    return s / 233280
  }
}

export function drawChalkLine(
  ctx: CanvasRenderingContext2D,
  points: Array<{ x: number; y: number }>,
  color: string,
  seed: ChalkSeed,
): void {
  if (points.length < 2) return
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  const passes = 3
  for (let p = 0; p < passes; p += 1) {
    const rand = seededRand((seed.width * 1000 + p * 7) | 0)
    ctx.beginPath()
    ctx.strokeStyle = color
    ctx.globalAlpha = seed.opacity * (1 - p * 0.15)
    ctx.lineWidth = seed.width * (1 - p * 0.25) * (0.8 + rand() * 0.4)
    const offset = (): number => (rand() - 0.5) * seed.roughness
    ctx.moveTo(points[0].x + offset(), points[0].y + offset())
    for (let i = 1; i < points.length; i += 1) {
      const { x, y } = points[i]
      const prev = points[i - 1]
      const mx = (prev.x + x) / 2 + offset()
      const my = (prev.y + y) / 2 + offset()
      ctx.quadraticCurveTo(prev.x + offset(), prev.y + offset(), mx, my)
    }
    ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y)
    ctx.stroke()
  }
  ctx.globalAlpha = 1
}
