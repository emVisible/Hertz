/** Canvas NLP domain: 词性分析 + 灵感重组。 */

import { api } from './client'

export interface CardPosOverview {
  text: string
  pos: Record<string, number>
}

export interface RemixResult {
  cards: CardPosOverview[]
  remixes: string[]
  pool: Record<string, string[]>
  wordbank?: Record<string, string[]>
}

export interface Wordbank {
  categories: Record<string, string[]>
}

export const canvasApi = {
  remix: (cards: string[]) => api.post<RemixResult>('/api/canvas/remix', { cards }),
  wordbank: () => api.get<Wordbank['categories']>('/api/canvas/wordbank'),
  saveWordbank: (categories: Record<string, string[]>) =>
    api.post<Wordbank['categories']>('/api/canvas/wordbank', { categories }),
}
