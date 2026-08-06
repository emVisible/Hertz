/**
 * 低语系统（Revel heritage）：
 * - wake：一段时间未触碰的画布，唤回注意力
 * - ghost：与既有卡片相似但未连线的卡片，提示建连
 * - prompt：随机提醒
 *
 * 纯数据输出：文案由 UI 层负责（AXIOM §22.2 用户可见字符串统一出口），
 * 本模块不返回任何用户可见字符串。
 */

import { randomId } from './id'

export type WhisperKind = 'wake' | 'ghost' | 'prompt'

export interface Whisper {
  id: string
  type: WhisperKind
  cardId?: string
  peer?: string
  promptIndex?: number
  strength: number
}

export const WAKE_IDLE_MS = 30_000
export const GHOST_SIMILARITY = 0.12

const PROMPT_COUNT = 6

function pickIndex(count: number): number {
  return Math.floor(Math.random() * count)
}

export interface WhisperInput {
  now: number
  lastTouchAt: number
  cardCount: number
  unconnectedSimilar: Array<{ cardId: string; peer: string; similarity: number }>
}

export function maybeWhisper(input: WhisperInput, existing: string[] = []): Whisper | null {
  if (input.cardCount === 0) return null

  if (input.now - input.lastTouchAt > WAKE_IDLE_MS) {
    return {
      id: randomId('w'),
      type: 'wake',
      strength: 1,
    }
  }

  // ghost 去重按「对」（cardId|peer）而非单卡：同一对（含反向）只提示一次
  const candidate = input.unconnectedSimilar
    .filter((u) => !existing.includes(`${u.cardId}|${u.peer}`))
    .sort((a, b) => b.similarity - a.similarity)[0]
  if (candidate && candidate.similarity >= GHOST_SIMILARITY) {
    return {
      id: randomId('w'),
      type: 'ghost',
      cardId: candidate.cardId,
      peer: candidate.peer,
      strength: 0.75,
    }
  }

  if (Math.random() < 0.35) {
    return {
      id: randomId('w'),
      type: 'prompt',
      promptIndex: pickIndex(PROMPT_COUNT),
      strength: 0.4,
    }
  }
  return null
}
