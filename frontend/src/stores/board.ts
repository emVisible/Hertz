import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { useMemo } from 'react'

import { randomId } from '../core/id'
import { CARD_COLORS, CHALK_COLORS, type Board, type Card, type ToolId } from '../canvas/types'
import { clusterCards } from '../core/cluster'
import { computeSimilarity } from '../core/similarity'
import { maybeWhisper, type Whisper, type WhisperInput } from '../core/whisper'
import { simplifyStroke, distanceToStroke } from '../canvas/stroke'

interface BoardState {
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
}

function defaultBoard(): Board {
  const now = Date.now()
  return {
    id: randomId('b'),
    name: 'Untitled Board',
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
    (set, get) => ({
      board: defaultBoard(),
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
        set({
          board: { ...board, cards: [...board.cards, card], updatedAt: Date.now() },
          lastTouchAt: Date.now(),
        })
        return card
      },

      setContent: (id, content) => {
        const { board } = get()
        set({
          board: {
            ...board,
            cards: board.cards.map((c) =>
              c.id === id ? { ...c, content, draft: false } : c,
            ),
            updatedAt: Date.now(),
          },
          lastTouchAt: Date.now(),
        })
      },

      moveCard: (id, x, y) => {
        const { board } = get()
        set({
          board: {
            ...board,
            cards: board.cards.map((c) => (c.id === id ? { ...c, x, y } : c)),
            updatedAt: Date.now(),
          },
          lastTouchAt: Date.now(),
        })
      },

      togglePin: (id) => {
        const { pinned } = get()
        set({
          pinned: pinned.includes(id) ? pinned.filter((p) => p !== id) : [...pinned, id],
        })
      },

      toggleConnect: (a, b) => {
        const { board } = get()
        if (a === b) return
        const connect = (c: Card): Card => {
          const has = c.connections.includes(b === c.id ? a : b)
          return { ...c, connections: has ? c.connections.filter((p) => p !== (b === c.id ? a : b)) : [...c.connections, b === c.id ? a : b] }
        }
        set({
          board: { ...board, cards: board.cards.map(connect), updatedAt: Date.now() },
          lastTouchAt: Date.now(),
        })
      },

      deleteCard: (id) => {
        const { board } = get()
        set({
          board: {
            ...board,
            cards: board.cards
              .filter((c) => c.id !== id)
              .map((c) => ({ ...c, connections: c.connections.filter((p) => p !== id) })),
            updatedAt: Date.now(),
          },
          selectedId: get().selectedId === id ? null : get().selectedId,
        })
      },

      addShapeStroke: (points, color = '#f8fafc') => {
        const { board } = get()
        if (points.length < 2) return
        const stroke = {
          id: randomId('s'),
          points: simplifyStroke(points),
          color,
          width: 2,
          createdAt: Date.now(),
        }
        set({
          board: { ...board, strokes: [...board.strokes, stroke], updatedAt: Date.now() },
          lastTouchAt: Date.now(),
        })
      },

      eraseAt: (x, y) => {
        const { board } = get()
        const remaining = board.strokes.filter((s) => distanceToStroke(s, x, y) > 16)
        if (remaining.length === board.strokes.length) return
        set({
          board: { ...board, strokes: remaining, updatedAt: Date.now() },
          lastTouchAt: Date.now(),
        })
      },

      shuffleCards: () => {
        const { board } = get()
        const shuffled = board.cards.map((c) => ({
          ...c,
          x: 80 + Math.random() * (Math.max(board.cards.length * 40, 400)),
          y: 60 + Math.random() * 300,
        }))
        set({
          board: { ...board, cards: shuffled, updatedAt: Date.now() },
          lastTouchAt: Date.now(),
        })
      },

      clearBoard: () => {
        const { board } = get()
        set({
          board: { ...board, cards: [], strokes: [], updatedAt: Date.now() },
          selectedId: null,
          pinned: [],
          lastTouchAt: Date.now(),
        })
      },






      clearStrokes: () => {
        const { board } = get()
        set({ board: { ...board, strokes: [], updatedAt: Date.now() } })
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
    }),
    {
      name: 'hertz::boards',
      partialize: (s) => ({
        board: { ...s.board, cards: s.board.cards.map(({ draft: _draft, ...rest }) => rest) },
        pinned: s.pinned,
      }),
      // 拖拽/笔迹每帧触发 setState，写 localStorage 会拖慢指针事件；
      // 节流到 500ms 合并一次，页面隐藏时强制落盘（AXIOM §7.2 性能预算）。
      storage: createJSONStorage(() => throttledLocalStorage),
      version: 1,
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
