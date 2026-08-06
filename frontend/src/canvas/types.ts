/** Canvas domain types (Revel heritage): cards, layers, strokes, board. */

/** 粉笔三色（单一真相源 AXIOM §1.2）：快捷键 1·2·3 与粉笔工具条共用。 */
export const CHALK_COLORS = ['#f8fafc', '#fde047', '#7dd3fc'] as const

export type CardType = 'text' | 'image'

export interface Card {
  id: string
  type: CardType
  content: string
  imageData?: string
  x: number
  y: number
  width: number
  height: number
  color: string
  layerId: string
  connections: string[]
  createdAt: number
  /** 新创建的空卡片：首帧即编辑态（数据驱动，不持久化） */
  draft?: boolean
}

export interface Layer {
  id: string
  name: string
  visible: boolean
  order: number
}

export interface Stroke {
  id: string
  points: Array<{ x: number; y: number }>
  color: string
  width: number
  createdAt: number
}

export interface Board {
  id: string
  name: string
  layers: Layer[]
  activeLayerId: string
  cards: Card[]
  strokes: Stroke[]
  createdAt: number
  updatedAt: number
}

export type ToolId = 'write' | 'pen' | 'erase' | 'rect' | 'ellipse' | 'line'

export const CARD_COLORS = ['#fde68a', '#bbf7d0', '#bae6fd', '#fbcfe8', '#ddd6fe'] as const
