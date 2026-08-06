/**
 * 轻浮漂移（Revel heritage）：卡片随时间做确定性正弦浮动，
 * 避免整块画布死板；纯函数、无外部状态。
 */

export interface Floater {
  seed: number
  amplitudeX: number
  amplitudeY: number
  speedX: number
  speedY: number
  phaseX: number
  phaseY: number
}

export function makeFloater(seed: number): Floater {
  let s = seed * 131 + 17
  const rand = (): number => {
    s = (s * 9301 + 49297) % 233280
    return s / 233280
  }
  return {
    seed,
    amplitudeX: 1.5 + rand() * 2.5,
    amplitudeY: 1 + rand() * 2,
    speedX: 0.0004 + rand() * 0.0005,
    speedY: 0.0003 + rand() * 0.0004,
    phaseX: rand() * Math.PI * 2,
    phaseY: rand() * Math.PI * 2,
  }
}

export function floatOffset(f: Floater, now: number): { dx: number; dy: number } {
  return {
    dx: Math.sin(now * f.speedX + f.phaseX) * f.amplitudeX,
    dy: Math.cos(now * f.speedY + f.phaseY) * f.amplitudeY,
  }
}
