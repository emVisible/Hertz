import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useBoardStore } from '../../stores/board'
import { spawnDust, updateDust, type Dust } from '../../canvas/background'
import { renderCanvas, renderConnections, renderStrokesToCanvas } from '../../canvas/renderer'
import { chalkSeed, drawChalkLine } from '../../canvas/chalk'
import { floatOffset, makeFloater } from '../../canvas/physics'
import { shapePoints } from '../../canvas/stroke'
import { computeSimilarity } from '../../core/similarity'
import { useBoardClusters } from '../../stores/board'
import type { Stroke } from '../../canvas/types'
import { CardView } from './CardView'

const SUGGESTION_THRESHOLD = 0.12
const SUGGESTION_LIMIT = 4
/** 画布平移边界（Revel heritage：单轴 ±260px 有界，弹性阻尼） */
const PAN_BOUND = 260

export function Board() {
  const { t } = useTranslation()
  const board = useBoardStore((s) => s.board)
  const tool = useBoardStore((s) => s.tool)
  const strokeColor = useBoardStore((s) => s.strokeColor)
  const selectedId = useBoardStore((s) => s.selectedId)
  const showClusters = useBoardStore((s) => s.showClusters)
  const touch = useBoardStore((s) => s.touch)
  const selectCard = useBoardStore((s) => s.selectCard)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const dustRef = useRef<Dust[]>([])
  const strokeCache = useRef<HTMLCanvasElement | null>(null)
  const strokeCacheKey = useRef('')
  const strokeRef = useRef<Stroke[] | null>(null)
  const activeStroke = useRef<Stroke | null>(null)
  const shapeDraft = useRef<{ shape: 'rect' | 'ellipse' | 'line'; from: { x: number; y: number }; to: { x: number; y: number } } | null>(null)
  const linkFrom = useRef<string | null>(null)
  const seedRef = useRef(chalkSeed(Date.now() % 233280))

  // ---- 画布平移（Space+拖拽，Revel heritage） ----
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [spaceHeld, setSpaceHeld] = useState(false)
  const panning = useRef<{ startX: number; startY: number } | null>(null)
  const lastPointer = useRef({ x: 0, y: 0 })

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return
      e.preventDefault()
      setSpaceHeld(true)
    }
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceHeld(false)
    }
    const blur = () => {
      setSpaceHeld(false)
      panning.current = null
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [])

  const clampPan = (v: number) => Math.max(-PAN_BOUND, Math.min(PAN_BOUND, v))

  function onWrapPointerDown(e: React.PointerEvent) {
    if (!spaceHeld) return
    e.preventDefault()
    e.stopPropagation()
    panning.current = { startX: e.clientX - pan.x, startY: e.clientY - pan.y }
    wrapRef.current?.setPointerCapture(e.pointerId)
  }

  function onWrapPointerMove(e: React.PointerEvent) {
    lastPointer.current = { x: e.clientX, y: e.clientY }
    if (!panning.current) return
    setPan({
      x: clampPan(e.clientX - panning.current.startX),
      y: clampPan(e.clientY - panning.current.startY),
    })
  }

  function onWrapPointerUp() {
    panning.current = null
  }

  /** 背景粘贴剪贴板图片 → 图片卡（Revel 同款交互；输入态粘贴由 CardView 处理）。 */
  function onWrapPaste(e: React.ClipboardEvent) {
    const file = Array.from(e.clipboardData.files).find((f) => f.type.startsWith('image/'))
    if (!file) return
    e.preventDefault()
    const reader = new FileReader()
    reader.onload = () => {
      const img = new Image()
      img.onload = () => {
        const scale = Math.min(320 / img.width, 240 / img.height, 1)
        const w = Math.round(img.width * scale)
        const h = Math.round(img.height * scale)
        // 贴在最近一次指针位置的可见区中心（世界坐标 = 屏幕坐标 - pan）
        const rect = wrapRef.current?.getBoundingClientRect()
        const x = rect ? lastPointer.current.x - rect.left - pan.x - w / 2 : undefined
        const y = rect ? lastPointer.current.y - rect.top - pan.y - h / 2 : undefined
        useBoardStore.getState().addImageCard(String(reader.result ?? ''), x, y)
      }
      img.src = String(reader.result ?? '')
    }
    reader.readAsDataURL(file)
  }

  const clusters = useBoardClusters()
  const addCard = useBoardStore((s) => s.addCard)
  const setEditing = useBoardStore((s) => s.setEditing)
  const editingId = useBoardStore((s) => s.editingId)

  // 选中卡的相似建议（Top-4 未连接卡）
  const suggestions = useMemo(() => {
    if (!selectedId) return []
    const card = board.cards.find((c) => c.id === selectedId)
    if (!card) return []
    const scored: Array<{ cardId: string; peerId: string; similarity: number }> = []
    for (const peer of board.cards) {
      if (peer.id === selectedId || card.connections.includes(peer.id)) continue
      const sim = computeSimilarity(card.content, peer.content)
      if (sim > SUGGESTION_THRESHOLD) scored.push({ cardId: card.id, peerId: peer.id, similarity: sim })
    }
    scored.sort((a, b) => b.similarity - a.similarity)
    return scored.slice(0, SUGGESTION_LIMIT)
  }, [selectedId, board.cards])

  // 幽灵对（低语复用的相似未连接对）
  const ghostPairs = useMemo(() => {
    const out: Array<{ cardId: string; peerId: string }> = []
    for (const card of board.cards) {
      for (const peer of board.cards) {
        if (peer.id <= card.id || card.connections.includes(peer.id)) continue
        if (clusters.get(card.id) !== clusters.get(peer.id)) continue
        if (computeSimilarity(card.content, peer.content) > SUGGESTION_THRESHOLD) {
          out.push({ cardId: card.id, peerId: peer.id })
        }
      }
    }
    return out.slice(0, 8)
  }, [board.cards, clusters])

  useEffect(() => {
    strokeRef.current = board.strokes
  }, [board.strokes])

  const floater = useRef(makeFloater(board.cards.length + 1))
  useEffect(() => {
    floater.current = makeFloater(board.cards.length + 7)
  }, [board.cards.length])

  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const resize = () => {
      canvas.width = wrap.clientWidth * devicePixelRatio
      canvas.height = wrap.clientHeight * devicePixelRatio
      ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0)
      dustRef.current = spawnDust(wrap.clientWidth, wrap.clientHeight, 70)
      strokeCache.current = null
      strokeCacheKey.current = ''
    }
    resize()

    let raf = 0
    let last = performance.now()
    const loop = (now: number) => {
      const dt = Math.min(now - last, 60)
      last = now
      const w = wrap.clientWidth
      const h = wrap.clientHeight
      updateDust(dustRef.current, w, h, dt)
      renderCanvas(ctx, { dust: dustRef.current, width: w, height: h, now })

      const state = useBoardStore.getState()
      const positions = new Map<string, { x: number; y: number }>()
      for (const card of state.board.cards) {
        const off = floatOffset(floater.current, now)
        positions.set(card.id, { x: card.x + card.width / 2 + off.dx, y: card.y + card.height / 2 + off.dy })
      }

      // 已提交笔迹：离屏缓存（仅笔迹变化时重建）
      const strokesKey = state.board.strokes.map((s) => s.id).join('|')
      if (strokeCacheKey.current !== strokesKey || !strokeCache.current) {
        strokeCache.current = renderStrokesToCanvas(state.board.strokes, w, h)
        strokeCacheKey.current = strokesKey
      }
      ctx.drawImage(strokeCache.current, 0, 0)

      // 未提交笔迹/图形预览：直接画
      if (activeStroke.current) {
        drawChalkLine(ctx, activeStroke.current.points, activeStroke.current.color, seedRef.current)
      }
      if (shapeDraft.current) {
        const pts = shapePoints(shapeDraft.current.shape, shapeDraft.current.from.x, shapeDraft.current.from.y, shapeDraft.current.to.x, shapeDraft.current.to.y)
        drawChalkLine(ctx, pts, strokeColor, seedRef.current)
      }

      renderConnections(ctx, {
        cards: state.board.cards,
        positions,
        now,
        selectedId: state.selectedId,
        showClusters: state.showClusters,
        clusters,
        suggestions,
        ghostPairs,
      })

      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    const observer = new ResizeObserver(resize)
    observer.observe(wrap)
    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusters, suggestions, ghostPairs])

  /** 屏幕坐标 → 世界坐标（减去平移偏移） */
  function boardPoint(e: React.PointerEvent): { x: number; y: number } {
    const rect = wrapRef.current!.getBoundingClientRect()
    return { x: e.clientX - rect.left - pan.x, y: e.clientY - rect.top - pan.y }
  }

  function onPointerDown(e: React.PointerEvent) {
    const p = boardPoint(e)
    const cardEl = (e.target as HTMLElement).closest('[data-card-id]')

    if (tool === 'pen') {
      activeStroke.current = { id: `s-${Date.now()}`, points: [p], color: strokeColor, width: 2, createdAt: Date.now() }
      e.currentTarget.setPointerCapture(e.pointerId)
      selectCard(null)
      return
    }
    if (tool === 'rect' || tool === 'ellipse' || tool === 'line') {
      if (tool === 'line' && cardEl) {
        const id = cardEl.getAttribute('data-card-id')!
        const state = useBoardStore.getState()
        if (!linkFrom.current) {
          linkFrom.current = id
          selectCard(id)
          touch()
        } else {
          state.toggleConnect(linkFrom.current, id)
          linkFrom.current = null
        }
        return
      }
      shapeDraft.current = { shape: tool, from: p, to: p }
      e.currentTarget.setPointerCapture(e.pointerId)
      selectCard(null)
      return
    }
    if (tool === 'erase') {
      selectCard(null)
      if (!cardEl) {
        useBoardStore.getState().eraseAt(p.x, p.y)
        e.currentTarget.setPointerCapture(e.pointerId)
      }
      return
    }
    // write 工具：点空白直接创建卡片（draft 卡片首帧即编辑，回车结束）
    if (tool === 'write') {
      if (!cardEl) {
        addCard('', p.x - 110, p.y - 40)
        touch()
      }
      return
    }
    // 其他工具点空白清选择
    selectCard(null)
  }

  function onPointerMove(e: React.PointerEvent) {
    lastPointer.current = { x: e.clientX, y: e.clientY }
    const p = boardPoint(e)
    if (activeStroke.current) {
      activeStroke.current = { ...activeStroke.current, points: [...activeStroke.current.points, p] }
      touch()
      return
    }
    if (shapeDraft.current) {
      shapeDraft.current = { ...shapeDraft.current, to: p }
      touch()
      return
    }
    if (tool === 'erase') {
      useBoardStore.getState().eraseAt(p.x, p.y)
    }
  }

  function onPointerUp() {
    const state = useBoardStore.getState()
    if (activeStroke.current) {
      const stroke = activeStroke.current
      activeStroke.current = null
      useBoardStore.setState({
        board: { ...state.board, strokes: [...state.board.strokes, stroke], updatedAt: Date.now() },
        boards: state.boards.map((b) => (b.id === state.activeBoardId ? { ...b, strokes: [...b.strokes, stroke], updatedAt: Date.now() } : b)),
        lastTouchAt: Date.now(),
      })
      return
    }
    if (shapeDraft.current) {
      const draft = shapeDraft.current
      shapeDraft.current = null
      state.addShapeStroke(shapePoints(draft.shape, draft.from.x, draft.from.y, draft.to.x, draft.to.y), strokeColor)
    }
  }

  const visibleCards = board.cards.filter((c) => {
    const layer = board.layers.find((l) => l.id === c.layerId)
    return layer?.visible !== false
  })

  return (
    <div
      ref={wrapRef}
      onPointerDownCapture={onWrapPointerDown}
      onPointerMove={onWrapPointerMove}
      onPointerUp={onWrapPointerUp}
      onPaste={onWrapPaste}
      className="relative min-h-0 flex-1 overflow-hidden "
    >
      <div style={{ transform: `translate(${pan.x}px, ${pan.y}px)` }} className="absolute inset-0">
        <canvas
          ref={canvasRef}
          className={`absolute inset-0 h-full w-full ${spaceHeld ? 'cursor-grab' : 'cursor-crosshair'}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        />
        {visibleCards.map((card) => (
          <CardView
            key={card.id}
            card={card}
            selected={selectedId === card.id}
            focused={!!selectedId && selectedId !== card.id}
            clustersVisible={showClusters}
            clusterColor={clusters.get(card.id) as string | undefined}
            editing={editingId === card.id}
            pan={pan}
            onEditDone={() => setEditing(null)}
            onSelect={() => {
              selectCard(card.id)
              touch()
            }}
          />
        ))}
      </div>
      {tool === 'write' && visibleCards.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-text-secondary">
          <p className="font-kai text-lg opacity-80">{t('canvas.emptyBoard')}</p>
          <p className="mt-1 text-xs opacity-60">{t('canvas.emptyHint')}</p>
        </div>
      )}
      <div className="pointer-events-none absolute right-3 top-3  bg-black/40 px-2 py-1 font-mono text-[10px] text-white/60">
        {t('canvas.metrics', { cards: visibleCards.length, strokes: board.strokes.length })}
      </div>
    </div>
  )
}
