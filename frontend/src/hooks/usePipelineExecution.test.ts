import { describe, expect, it } from 'vitest'

import { chunkIds } from './usePipelineExecution'

describe('chunkIds', () => {
  it('splits into chunks of at most 200', () => {
    const ids = Array.from({ length: 500 }, (_, i) => `id-${i}`)
    const chunks = chunkIds(ids)
    expect(chunks.length).toBe(3)
    expect(chunks[0].length).toBe(200)
    expect(chunks[1].length).toBe(200)
    expect(chunks[2].length).toBe(100)
    expect(chunks.flat()).toEqual(ids)
  })

  it('returns a single chunk for at most 200 ids', () => {
    const ids = Array.from({ length: 200 }, (_, i) => `id-${i}`)
    const chunks = chunkIds(ids)
    expect(chunks.length).toBe(1)
    expect(chunks[0]).toEqual(ids)
  })

  it('preserves order', () => {
    const ids = ['a', 'b', 'c', 'd', 'e']
    expect(chunkIds(ids).flat()).toEqual(ids)
  })
})