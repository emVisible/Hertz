/**
 * 黑板背景（Revel heritage）：深绿黑板 + 浮尘粒子缓慢漂移。
 */

export interface Dust {
  x: number
  y: number
  r: number
  speed: number
  drift: number
  alpha: number
}

export function spawnDust(width: number, height: number, count: number): Dust[] {
  const dust: Dust[] = []
  for (let i = 0; i < count; i += 1) {
    dust.push({
      x: Math.random() * width,
      y: Math.random() * height,
      r: 0.4 + Math.random() * 1.1,
      speed: 0.004 + Math.random() * 0.008,
      drift: (Math.random() - 0.5) * 0.01,
      alpha: 0.08 + Math.random() * 0.15,
    })
  }
  return dust
}

export function updateDust(dust: Dust[], width: number, height: number, dt: number): void {
  for (const d of dust) {
    d.y += d.speed * dt
    d.x += d.drift * dt + Math.sin((d.x + d.y) * 0.01) * 0.003 * dt
    if (d.y > height + 4) {
      d.y = -4
      d.x = Math.random() * width
    }
    if (d.x < -4) d.x = width + 4
  }
}

export function drawBackground(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  dust: Dust[],
): void {
  // 背景随主题（AXIOM §27）：light = 白系 / dark = 深灰黑——白天拖动不再闪黑
  const styles = getComputedStyle(document.documentElement)
  const isDark = document.documentElement.classList.contains('dark')
  const edge = styles.getPropertyValue('--hz-bg').trim() || (isDark ? '#0a0a0b' : '#fafafa')
  const center = styles.getPropertyValue('--hz-surface-1').trim() || (isDark ? '#1b1b20' : '#ffffff')
  const gradient = ctx.createRadialGradient(width / 2, height / 2, 40, width / 2, height / 2, width * 0.8)
  gradient.addColorStop(0, center)
  gradient.addColorStop(1, edge)
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, width, height)

  ctx.fillStyle = isDark ? '#f4f4f5' : '#a1a1aa'
  for (const d of dust) {
    ctx.globalAlpha = d.alpha
    ctx.beginPath()
    ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalAlpha = 1
}
