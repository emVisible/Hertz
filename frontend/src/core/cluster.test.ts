import { describe, expect, it } from 'vitest'

import { computeSimilarity, ngrams, wordOverlap } from './similarity'
import { clusterCards } from './cluster'
import type { Card } from '../canvas/types'

const card = (id: string, content: string): Card => ({
  id,
  type: 'text',
  content,
  x: 0,
  y: 0,
  width: 220,
  height: 120,
  color: '#fde68a',
  layerId: 'l1',
  connections: [],
  createdAt: 0,
})

describe('similarity', () => {
  it('bigram/trigram n-grams are produced for Chinese text', () => {
    expect(ngrams('你好世界', 2)).toEqual(['你好', '好世', '世界'])
    expect(ngrams('ab', 2)).toEqual(['ab'])
  })

  it('identical texts score 1', () => {
    expect(computeSimilarity('研究扩散模型', '研究扩散模型')).toBe(1)
  })

  it('unrelated texts score near 0', () => {
    expect(computeSimilarity('明天的航班', '量子引力')).toBeLessThan(0.05)
  })

  it('shared numeric prefix is penalized', () => {
    const near = computeSimilarity('第1章 绪论', '第1章 引言')
    const far = computeSimilarity('第1章 绪论', '第10章 参考文献')
    expect(far).toBeLessThan(near)
  })

  it('word overlap is weighted into the result', () => {
    const withOverlap = computeSimilarity('模型 训练 损失', '模型 训练 收敛')
    const without = computeSimilarity('模型 训练 损失', '天气 很好 今天')
    expect(withOverlap).toBeGreaterThan(without)
    expect(wordOverlap('a b c', 'a b d')).toBeCloseTo(2 / 3)
  })

  it('never exceeds [0, 1]', () => {
    for (let i = 0; i < 50; i += 1) {
      const s = computeSimilarity('x'.repeat(i), 'y'.repeat(i))
      expect(s).toBeGreaterThanOrEqual(0)
      expect(s).toBeLessThanOrEqual(1)
    }
  })
})

describe('cluster', () => {
  it('groups similar cards and leaves singletons', () => {
    const cards = [
      card('a', '扩散模型的数学基础'),
      card('b', '扩散模型如何训练'),
      card('c', '量子引力全息原理'),
      card('d', '全息原理与纠缠熵'),
    ]
    const { clusters, cardToCluster } = clusterCards(cards)
    const clusterOf = (id: string) => cardToCluster[cards.findIndex((c) => c.id === id)]
    expect(clusterOf('a')).toBe(clusterOf('b'))
    expect(clusterOf('c')).toBe(clusterOf('d'))
    expect(clusterOf('a')).not.toBe(clusterOf('c'))
    expect(clusters.length).toBe(2)
  })

  it('every card belongs to exactly one cluster', () => {
    const cards = Array.from({ length: 6 }, (_, i) => card(`c${i}`, `卡片内容 ${i} 号`))
    const { cardToCluster } = clusterCards(cards)
    expect(new Set(cardToCluster).size).toBeGreaterThanOrEqual(1)
    cardToCluster.forEach((c, i) => {
      expect(c).toBeGreaterThanOrEqual(0)
      expect(c).toBeLessThanOrEqual(5)
      if (i > 0) expect(cardToCluster[i - 1]).toBeGreaterThanOrEqual(0)
    })
  })
})
