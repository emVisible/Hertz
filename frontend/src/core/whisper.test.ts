import { describe, expect, it } from 'vitest'

import { maybeWhisper, WAKE_IDLE_MS, GHOST_SIMILARITY } from './whisper'

const base = {
  now: 100_000,
  lastTouchAt: 100_000,
  cardCount: 1,
  unconnectedSimilar: [],
}

describe('whisper', () => {
  it('returns null on empty board', () => {
    expect(maybeWhisper({ ...base, cardCount: 0 })).toBeNull()
  })

  it('wakes after idle threshold', () => {
    const w = maybeWhisper({ ...base, lastTouchAt: base.now - WAKE_IDLE_MS - 1 })
    expect(w?.type).toBe('wake')
  })

  it('prefers ghost over random prompt', () => {
    const w = maybeWhisper({
      ...base,
      unconnectedSimilar: [{ cardId: 'x', peer: '既有卡片内容', similarity: 0.2 }],
    })
    expect(w?.type).toBe('ghost')
    expect(w?.cardId).toBe('x')
  })

  it('ignores ghosts below threshold', () => {
    const w = maybeWhisper({
      ...base,
      unconnectedSimilar: [{ cardId: 'x', peer: 'p', similarity: GHOST_SIMILARITY - 0.05 }],
    })
    expect(w?.type).not.toBe('ghost')
  })

  it('dedupes existing whispers', () => {
    const w = maybeWhisper(
      {
        ...base,
        unconnectedSimilar: [
          { cardId: 'x', peer: 'p', similarity: 0.9 },
          { cardId: 'y', peer: 'p2', similarity: 0.8 },
        ],
      },
      ['x|p'],
    )
    expect(w?.cardId).toBe('y')
  })

  it('may emit a prompt randomly with a stable index', () => {
    let prompts = 0
    for (let i = 0; i < 200; i += 1) {
      const w = maybeWhisper(base)
      if (w?.type === 'prompt') {
        prompts += 1
        expect(w.promptIndex).toBeGreaterThanOrEqual(0)
        expect(w.promptIndex).toBeLessThan(6)
      }
    }
    expect(prompts).toBeGreaterThan(0)
  })
})
