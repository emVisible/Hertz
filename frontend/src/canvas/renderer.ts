/**
 * 画布渲染器（Revel heritage）：背景 + 连线（流动光点）+ 聚类着色 +
 * 选中建议边 + 幽灵虚线。卡片本体由 DOM 渲染，视觉层全走 canvas。
 */

import { drawBackground, type Dust } from './background'
import type { Card, Stroke } from './types'
import { drawChalkLine, chalkSeed } from './chalk'

export interface RenderCall {
  dust: Dust[]
  width: number
  height: number
  now: number
}

export function renderCanvas(
  ctx: CanvasRenderingContext2D,
  call: RenderCall,
): void {
  drawBackground(ctx, call.width, call.height, call.dust)
}

export interface ConnectionsCall {
  cards: Card[]
  positions: Map<string, { x: number; y: number }>
  now: number
  selectedId: string | null
  showClusters: boolean
  clusters: Map<string, number>
  suggestions: Array<{ cardId: string; peerId: string; similarity: number }>
  ghostPairs: Array<{ cardId: string; peerId: string }>
}

function clusterColor(cluster: number): string {
  const palette = ['#f0f4ef', '#f472b6', '#a78bfa', '#60a5fa', '#34d399', '#fbbf24', '#f87171']
  return palette[cluster % palette.length]
}

export function renderConnections(ctx: CanvasRenderingContext2D, call: ConnectionsCall): void {
  const { cards, positions, now, selectedId, showClusters, clusters, suggestions, ghostPairs } = call
  const byId = new Map(cards.map((c) => [c.id, c]))

  // 1) 常规连线：双二次曲线 + 沿线流动光点
  for (const card of cards) {
    const from = positions.get(card.id)
    if (!from) continue
    for (const peerId of card.connections) {
      const peer = byId.get(peerId)
      const to = positions.get(peerId)
      if (!peer || !to) continue
      const active = selectedId === card.id || selectedId === peerId
      const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 - 26 }
      ctx.beginPath()
      ctx.strokeStyle = active ? '#e879f9' : showClusters && clusters.has(card.id) ? clusterColor(clusters.get(card.id) ?? 0) : '#f0f4ef'
      ctx.globalAlpha = active ? 0.6 : 0.32
      ctx.lineWidth = active ? 2 : 1.4
      ctx.setLineDash(active ? [] : [6, 6])
      ctx.moveTo(from.x, from.y)
      ctx.quadraticCurveTo(mid.x, mid.y, to.x, to.y)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.globalAlpha = 1
      // 流动光点（脉冲）
      const t = (now / 1400) % 1
      const dot = pointOnQuad(from, mid, to, t)
      ctx.beginPath()
      ctx.fillStyle = active ? '#f0abfc' : '#ffffff'
      ctx.globalAlpha = 0.7
      ctx.arc(dot.x, dot.y, active ? 3 : 2, 0, Math.PI * 2)
      ctx.fill()
      ctx.globalAlpha = 1
    }
  }

  // 2) 选中卡的建议边（Top-4 相似，琥珀虚线）
  for (const sug of suggestions) {
    const from = positions.get(sug.cardId)
    const to = positions.get(sug.peerId)
    if (!from || !to) continue
    ctx.beginPath()
    ctx.strokeStyle = '#fbbf24'
    ctx.globalAlpha = 0.55
    ctx.lineWidth = 1.4
    ctx.setLineDash([2, 6])
    ctx.moveTo(from.x, from.y)
    ctx.quadraticCurveTo((from.x + to.x) / 2, (from.y + to.y) / 2 - 26, to.x, to.y)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.globalAlpha = 1
  }

  // 3) 幽灵虚线（低语发现的相似但未连接对）
  for (const pair of ghostPairs) {
    const from = positions.get(pair.cardId)
    const to = positions.get(pair.peerId)
    if (!from || !to) continue
    ctx.beginPath()
    ctx.strokeStyle = '#94a3b8'
    ctx.globalAlpha = 0.28
    ctx.lineWidth = 1.2
    ctx.setLineDash([3, 8])
    ctx.moveTo(from.x, from.y)
    ctx.quadraticCurveTo((from.x + to.x) / 2, (from.y + to.y) / 2 - 26, to.x, to.y)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.globalAlpha = 1
  }
}

function pointOnQuad(
  a: { x: number; y: number },
  mid: { x: number; y: number },
  b: { x: number; y: number },
  t: number,
): { x: number; y: number } {
  const u = 1 - t
  return {
    x: u * u * a.x + 2 * u * t * mid.x + t * t * b.x,
    y: u * u * a.y + 2 * u * t * mid.y + t * t * b.y,
  }
}

/** 已提交笔迹的离屏缓存：笔迹集合变化时重建，动画帧只 drawImage（AXIOM §7.2）。 */
export function renderStrokesToCanvas(
  strokes: Stroke[],
  width: number,
  height: number,
): HTMLCanvasElement {
  const off = document.createElement('canvas')
  off.width = width
  off.height = height
  const ctx = off.getContext('2d')
  if (!ctx) return off
  for (const stroke of strokes) {
    drawChalkLine(ctx, stroke.points, stroke.color, chalkSeed(stroke.createdAt % 233280))
  }
  return off
}
