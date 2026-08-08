import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { useMemo } from 'react'

import { randomId } from '../core/id'
import { CARD_COLORS, CHALK_COLORS, type Board, type Card, type Layer, type ToolId } from '../canvas/types'
import { clusterCards } from '../core/cluster'
import { computeSimilarity } from '../core/similarity'
import { maybeWhisper, type Whisper, type WhisperInput } from '../core/whisper'
import { simplifyStroke, distanceToStroke } from '../canvas/stroke'

interface BoardState {
  /** 多板（Revel heritage）：所有板 + 当前激活板 id；`board` 为激活板的便捷引用 */
  boards: Board[]
  activeBoardId: string
  board: Board
  tool: ToolId
  strokeColor: string
  pinned: string[]
  selectedId: string | null
  showClusters: boolean
  editingId: string | null
  ghostSeen: string[]
  whispers: Whisper[]
  lastTouchAt: number

  touch: () => void
  setTool: (tool: ToolId) => void
  setStrokeColor: (color: string) => void
  setEditing: (id: string | null) => void
  selectCard: (id: string | null) => void
  toggleClusters: () => void
  addCard: (content: string, x?: number, y?: number) => Card
  addImageCard: (imageData: string, x?: number, y?: number) => void
  setCardImage: (id: string, imageData: string, width: number, height: number) => void
  setContent: (id: string, content: string) => void
  moveCard: (id: string, x: number, y: number) => void
  togglePin: (id: string) => void
  toggleConnect: (a: string, b: string) => void
  deleteCard: (id: string) => void
  addShapeStroke: (points: Array<{ x: number; y: number }>, color?: string) => void
  eraseAt: (x: number, y: number) => void
  shuffleCards: () => void
  clearBoard: () => void
  clearStrokes: () => void
  addWhisper: (input: WhisperInput) => void
  dismissWhisper: (id: string) => void

  // ---- 多板（Revel heritage） ----
  addBoard: () => void
  renameBoard: (id: string, name: string) => void
  removeBoard: (id: string) => void
  switchBoard: (id: string) => void

  // ---- 图层（数据层早已存在，Revel heritage 补齐 UI 动作） ----
  addLayer: () => void
  renameLayer: (id: string, name: string) => void
  toggleLayer: (id: string) => void
  moveLayer: (id: string, dir: 1 | -1) => void
  setActiveLayer: (id: string) => void

  // ---- 导入 / 导出（.revel.json 互通） ----
  exportBoardJson: () => string
  importBoardJson: (json: string) => boolean
}

function defaultBoard(name = 'Untitled Board'): Board {
  const now = Date.now()
  return {
    id: randomId('b'),
    name,
    layers: [{ id: 'l-default', name: 'Layer 1', visible: true, order: 0 }],
    activeLayerId: 'l-default',
    cards: [],
    strokes: [],
    createdAt: now,
    updatedAt: now,
  }
}

const MAX_WHISPERS = 5

export const useBoardStore = create<BoardState>()(
  persist(
    (set, get) => {
      /** 所有写操作统一入口：更新 boards 数组 + 激活板引用（单一真相源 AXIOM §1.2）。 */
      function mutate(fn: (b: Board) => Board, patch: Partial<BoardState> = {}) {
        const { boards, activeBoardId } = get()
        const next = boards.map((b) => (b.id === activeBoardId ? fn(b) : b))
        const active = next.find((b) => b.id === activeBoardId) ?? next[0]
        set({ boards: next, board: active, lastTouchAt: Date.now(), ...patch })
      }

      const initial = defaultBoard()
      return {
        boards: [initial],
        activeBoardId: initial.id,
        board: initial,
        tool: 'write',
        strokeColor: CHALK_COLORS[0],
        pinned: [],
        selectedId: null,
        showClusters: false,
        editingId: null,
        ghostSeen: [],
        whispers: [],
        lastTouchAt: Date.now(),

        touch: () => set({ lastTouchAt: Date.now() }),

        setTool: (tool) => set({ tool }),

        setStrokeColor: (color) => set({ strokeColor: color }),

        setEditing: (id) => set({ editingId: id }),

        selectCard: (id) => set({ selectedId: id }),

        toggleClusters: () => set((s) => ({ showClusters: !s.showClusters })),

        addCard: (content, x, y) => {
          const { board } = get()
          const card: Card = {
            id: randomId('c'),
            type: 'text',
            content,
            x: x ?? 120 + Math.random() * 160,
            y: y ?? 90 + Math.random() * 120,
            width: Math.min(Math.max(140, content.length * 8 + 40), 320),
            height: Math.max(56, Math.ceil(content.length / 22) * 20 + 36),
            color: CARD_COLORS[board.cards.length % CARD_COLORS.length],
            layerId: board.activeLayerId,
            connections: [],
            createdAt: Date.now(),
            // 空内容新卡 = 草稿态：首帧即编辑（数据驱动，与卡片同一次更新）
            draft: content === '',
          }
          mutate((b) => ({ ...b, cards: [...b.cards, card], updatedAt: Date.now() }))
          return card
        },

        addImageCard: (imageData, x, y) => {
          const { board } = get()
          const card: Card = {
            id: randomId('c'),
            type: 'image',
            content: '',
            imageData,
            x: x ?? 120 + Math.random() * 160,
            y: y ?? 90 + Math.random() * 120,
            width: 200,
            height: 200,
            color: CARD_COLORS[board.cards.length % CARD_COLORS.length],
            layerId: board.activeLayerId,
            connections: [],
            createdAt: Date.now(),
          }
          mutate((b) => ({ ...b, cards: [...b.cards, card], updatedAt: Date.now() }))
        },

        /** 粘贴图片时把当前编辑卡转换为图片卡（Revel 同款交互）。 */
        setCardImage: (id, imageData, width, height) => {
          mutate((b) => ({
            ...b,
            cards: b.cards.map((c) =>
              c.id === id
                ? { ...c, type: 'image', imageData, content: '', width, height, draft: false }
                : c,
            ),
            updatedAt: Date.now(),
          }))
        },

        setContent: (id, content) => {
          mutate((b) => ({
            ...b,
            cards: b.cards.map((c) =>
              c.id === id ? { ...c, content, draft: false } : c,
            ),
            updatedAt: Date.now(),
          }))
        },

        moveCard: (id, x, y) => {
          mutate((b) => ({
            ...b,
            cards: b.cards.map((c) => (c.id === id ? { ...c, x, y } : c)),
            updatedAt: Date.now(),
          }))
        },

        togglePin: (id) => {
          const { pinned } = get()
          set({
            pinned: pinned.includes(id) ? pinned.filter((p) => p !== id) : [...pinned, id],
          })
        },

        toggleConnect: (a, b) => {
          if (a === b) return
          const connect = (c: Card): Card => {
            const has = c.connections.includes(b === c.id ? a : b)
            return { ...c, connections: has ? c.connections.filter((p) => p !== (b === c.id ? a : b)) : [...c.connections, b === c.id ? a : b] }
          }
          mutate((board) => ({ ...board, cards: board.cards.map(connect), updatedAt: Date.now() }))
        },

        deleteCard: (id) => {
          const { selectedId } = get()
          mutate((b) => ({
            ...b,
            cards: b.cards
              .filter((c) => c.id !== id)
              .map((c) => ({ ...c, connections: c.connections.filter((p) => p !== id) })),
            updatedAt: Date.now(),
          }))
          if (selectedId === id) set({ selectedId: null })
        },

        addShapeStroke: (points, color = '#f8fafc') => {
          if (points.length < 2) return
          const stroke = {
            id: randomId('s'),
            points: simplifyStroke(points),
            color,
            width: 2,
            createdAt: Date.now(),
          }
          mutate((b) => ({ ...b, strokes: [...b.strokes, stroke], updatedAt: Date.now() }))
        },

        eraseAt: (x, y) => {
          const { board } = get()
          const remaining = board.strokes.filter((s) => distanceToStroke(s, x, y) > 16)
          if (remaining.length === board.strokes.length) return
          mutate((b) => ({ ...b, strokes: remaining, updatedAt: Date.now() }))
        },

        shuffleCards: () => {
          const { board } = get()
          const shuffled = board.cards.map((c) => ({
            ...c,
            x: 80 + Math.random() * (Math.max(board.cards.length * 40, 400)),
            y: 60 + Math.random() * 300,
          }))
          mutate((b) => ({ ...b, cards: shuffled, updatedAt: Date.now() }))
        },

        clearBoard: () => {
          mutate((b) => ({ ...b, cards: [], strokes: [], updatedAt: Date.now() }))
          set({ selectedId: null, pinned: [] })
        },

        clearStrokes: () => {
          mutate((b) => ({ ...b, strokes: [], updatedAt: Date.now() }))
        },

        addWhisper: (input) => {
          const seen = get().ghostSeen
          const existing = [
            ...seen,
            ...get().whispers.map((w) => (w.type === 'ghost' ? `${w.cardId}|${w.peer}` : '')),
          ]
          const whisper = maybeWhisper(input, existing)
          if (!whisper) return
          if (whisper.type === 'ghost') {
            seen.push(`${whisper.cardId}|${whisper.peer}`)
          }
          set((s) => ({
            ghostSeen: seen.slice(-60),
            whispers: [...s.whispers.slice(-(MAX_WHISPERS - 1)), whisper],
          }))
        },

        dismissWhisper: (id) => {
          const target = get().whispers.find((w) => w.id === id)
          const seen = get().ghostSeen
          if (target?.type === 'ghost') {
            seen.push(`${target.cardId}|${target.peer}`)
          }
          set((s) => ({
            ghostSeen: seen.slice(-60),
            whispers: s.whispers.filter((w) => w.id !== id),
          }))
        },

        // ---- 多板 ----

        addBoard: () => {
          const fresh = defaultBoard(`Board ${get().boards.length + 1}`)
          set({ boards: [...get().boards, fresh], activeBoardId: fresh.id, board: fresh, selectedId: null, pinned: [] })
        },

        renameBoard: (id, name) => {
          const nameClean = name.trim().slice(0, 60) || 'Untitled Board'
          set((s) => ({
            boards: s.boards.map((b) => (b.id === id ? { ...b, name: nameClean, updatedAt: Date.now() } : b)),
            board: s.board.id === id ? { ...s.board, name: nameClean, updatedAt: Date.now() } : s.board,
          }))
        },

        removeBoard: (id) => {
          const { boards, activeBoardId } = get()
          if (boards.length <= 1) return // 至少保留一块板
          const next = boards.filter((b) => b.id !== id)
          const active = activeBoardId === id ? next[0] : get().board
          set({
            boards: next,
            activeBoardId: active.id,
            board: active,
            selectedId: null,
            pinned: [],
            editingId: null,
          })
        },

        switchBoard: (id) => {
          const target = get().boards.find((b) => b.id === id)
          if (!target || target.id === get().activeBoardId) return
          set({ activeBoardId: id, board: target, selectedId: null, pinned: [], editingId: null })
        },

        // ---- 图层 ----

        addLayer: () => {
          const { board } = get()
          const layer: Layer = {
            id: randomId('l'),
            name: `Layer ${board.layers.length + 1}`,
            visible: true,
            order: board.layers.length,
          }
          mutate((b) => ({
            ...b,
            layers: [...b.layers, layer],
            activeLayerId: layer.id,
            updatedAt: Date.now(),
          }))
        },

        renameLayer: (id, name) => {
          mutate((b) => ({
            ...b,
            layers: b.layers.map((l) => (l.id === id ? { ...l, name: name.slice(0, 40) || l.name } : l)),
            updatedAt: Date.now(),
          }))
        },

        toggleLayer: (id) => {
          mutate((b) => ({
            ...b,
            layers: b.layers.map((l) => (l.id === id ? { ...l, visible: !l.visible } : l)),
            updatedAt: Date.now(),
          }))
        },

        /** 图层排序：order 大者在上（与卡片渲染层级一致）。 */
        moveLayer: (id, dir) => {
          const { board } = get()
          const sorted = [...board.layers].sort((a, b) => b.order - a.order)
          const index = sorted.findIndex((l) => l.id === id)
          const target = index + dir
          if (index < 0 || target < 0 || target >= sorted.length) return
          const [moved] = sorted.splice(index, 1)
          sorted.splice(target, 0, moved)
          const layers = sorted.map((l, i) => ({ ...l, order: sorted.length - 1 - i }))
          mutate((b) => ({ ...b, layers, updatedAt: Date.now() }))
        },

        setActiveLayer: (id) => {
          mutate((b) => ({ ...b, activeLayerId: id, updatedAt: Date.now() }))
        },

        // ---- 导入 / 导出 ----

        exportBoardJson: () => {
          const { board } = get()
          return JSON.stringify({ ...board, cards: board.cards.map(({ draft: _draft, ...rest }) => rest) }, null, 2)
        },

        /** 导入 .revel.json（与 Revel 原项目格式互通），成功返回 true。 */
        importBoardJson: (json) => {
          try {
            const parsed = JSON.parse(json) as Board
            if (!Array.isArray(parsed.cards) || !Array.isArray(parsed.layers)) return false
            const imported: Board = {
              ...parsed,
              id: randomId('b'),
              name: `${parsed.name || 'Imported'} ← imported`,
              cards: parsed.cards.map((c) => ({ ...c, draft: false })),
              strokes: Array.isArray(parsed.strokes) ? parsed.strokes : [],
              activeLayerId: parsed.activeLayerId ?? parsed.layers[0]?.id ?? 'l-default',
              createdAt: Date.now(),
              updatedAt: Date.now(),
            }
            set({
              boards: [...get().boards, imported],
              activeBoardId: imported.id,
              board: imported,
              selectedId: null,
              pinned: [],
            })
            return true
          } catch {
            return false
          }
        },
      }
    },
    {
      name: 'hertz::boards',
      partialize: (s) => ({
        boards: s.boards.map((b) => ({
          ...b,
          cards: b.cards.map(({ draft: _draft, ...rest }) => rest),
        })),
        activeBoardId: s.activeBoardId,
        pinned: s.pinned,
      }),
      migrate: (persisted, version) => {
        // v1 → v2：单板 board 迁移为 boards 数组（多板，Revel heritage）
        if (version < 2) {
          const old = persisted as { board?: Board; pinned?: string[] }
          const board = old.board ?? defaultBoard()
          return { boards: [board], activeBoardId: board.id, pinned: old.pinned ?? [] }
        }
        return persisted as Partial<BoardState>
      },
      // 拖拽/笔迹每帧触发 setState，写 localStorage 会拖慢指针事件；
      // 节流到 500ms 合并一次，页面隐藏时强制落盘（AXIOM §7.2 性能预算）。
      storage: createJSONStorage(() => throttledLocalStorage),
      version: 2,
    },
  ),
)

const THROTTLE_MS = 500
let saveTimer: ReturnType<typeof setTimeout> | null = null
let pendingSave: string | null = null

function flushSave(): void {
  if (pendingSave === null) return
  const payload = pendingSave
  pendingSave = null
  try {
    window.localStorage.setItem('hertz::boards', payload)
  } catch {
    /* quota exceeded — keep the in-memory state */
  }
}

const throttledLocalStorage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = {
  getItem: (key) => window.localStorage.getItem(key),
  setItem: (_key, value) => {
    pendingSave = value
    if (saveTimer !== null) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      flushSave()
    }, THROTTLE_MS)
  },
  removeItem: (key) => {
    pendingSave = null
    if (saveTimer !== null) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    window.localStorage.removeItem(key)
  },
}

window.addEventListener('beforeunload', flushSave)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushSave()
})

export function unconnectedSimilarPairs(
  cards: Card[],
  clusterOf: Map<string, number>,
): Array<{ cardId: string; peer: string; similarity: number }> {
  const out: Array<{ cardId: string; peer: string; similarity: number }> = []
  for (const card of cards) {
    const members = cards.filter((c) => c.id !== card.id && !card.connections.includes(c.id))
    for (const member of members) {
      if (clusterOf.get(card.id) !== clusterOf.get(member.id)) continue
      const similarity = computeSimilarity(card.content, member.content)
      if (similarity > 0) out.push({ cardId: card.id, peer: member.content, similarity })
    }
  }
  return out
}

export function useBoardClusters(): Map<string, number> {
  const cards = useBoardStore((s) => s.board.cards)
  return useMemo(() => {
    const { cardToCluster } = clusterCards(cards)
    return new Map(cards.map((c, i) => [c.id, cardToCluster[i]]))
  }, [cards])
}
