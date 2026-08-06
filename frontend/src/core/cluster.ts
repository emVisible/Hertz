/**
 * 卡片聚类：相似度超阈值建边，连通分量即簇。
 * 返回每张卡片的簇索引（-1 = 未分组），簇按创建顺序稳定。
 */

import { computeSimilarity, SUGGESTION_THRESHOLD } from './similarity'
import type { Card } from '../canvas/types'

export interface ClusterResult {
  clusters: number[][]
  cardToCluster: number[]
}

export function clusterCards(cards: Card[], threshold = SUGGESTION_THRESHOLD): ClusterResult {
  const cardToCluster: number[] = new Array(cards.length).fill(-1)
  const clusters: number[][] = []
  for (let i = 0; i < cards.length; i += 1) {
    if (cardToCluster[i] !== -1) continue
    const stack = [i]
    cardToCluster[i] = clusters.length
    const members: number[] = []
    while (stack.length > 0) {
      const idx = stack.pop() as number
      members.push(idx)
      for (let j = 0; j < cards.length; j += 1) {
        if (j === idx || cardToCluster[j] !== -1) continue
        if (computeSimilarity(cards[idx].content, cards[j].content) >= threshold) {
          cardToCluster[j] = clusters.length
          stack.push(j)
        }
      }
    }
    clusters.push(members)
  }
  return { clusters, cardToCluster }
}
