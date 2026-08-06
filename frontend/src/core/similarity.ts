/**
 * 文本相似度（Revel heritage）：
 * - char bigram/trigram cosine，中文为主要语料
 * - 词重叠率加权
 * - 共享长前缀惩罚（避免 "第1章" "第10章" 误判）
 */

const BIGRAM_W = 0.3
const TRIGRAM_W = 0.3
const WORD_OVERLAP_W = 0.4
const PREFIX_PENALTY = 0.08

export function normalizeText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ')
}

export function ngrams(text: string, n: number): string[] {
  const clean = normalizeText(text)
  if (clean.length < n) return [clean]
  const out: string[] = []
  for (let i = 0; i <= clean.length - n; i += 1) {
    out.push(clean.slice(i, i + n))
  }
  return out
}

export function cosine(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const counts = new Map<string, number>()
  for (const g of a) counts.set(g, (counts.get(g) ?? 0) + 1)
  const bCounts = new Map<string, number>()
  for (const g of b) bCounts.set(g, (bCounts.get(g) ?? 0) + 1)
  let dot = 0
  for (const [g, c] of counts) dot += c * (bCounts.get(g) ?? 0)
  let normA = 0
  for (const c of counts.values()) normA += c * c
  let normB = 0
  for (const c of bCounts.values()) normB += c * c
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

export function wordOverlap(a: string, b: string): number {
  const wa = new Set(normalizeText(a).split(' ').filter(Boolean))
  const wb = new Set(normalizeText(b).split(' ').filter(Boolean))
  if (wa.size === 0 || wb.size === 0) return 0
  let shared = 0
  for (const w of wa) if (wb.has(w)) shared += 1
  return shared / Math.max(wa.size, wb.size)
}

export function sharedPrefixPenalty(a: string, b: string): number {
  const na = normalizeText(a)
  const nb = normalizeText(b)
  if (na === nb) return 0
  let i = 0
  const max = Math.min(na.length, nb.length)
  while (i < max && na[i] === nb[i]) i += 1
  if (i < 4) return 0
  const divergesOnDigit = /[0-9]/.test(na[i] ?? '') || /[0-9]/.test(nb[i] ?? '')
  if (!divergesOnDigit) return 0
  return Math.min((i - 3) * PREFIX_PENALTY, 0.5)
}

export function computeSimilarity(a: string, b: string): number {
  if (normalizeText(a) === normalizeText(b)) return 1
  const bigram = cosine(ngrams(a, 2), ngrams(b, 2))
  const trigram = cosine(ngrams(a, 3), ngrams(b, 3))
  const overlap = wordOverlap(a, b)
  const raw = bigram * BIGRAM_W + trigram * TRIGRAM_W + overlap * WORD_OVERLAP_W
  return Math.max(0, Math.min(1, raw - sharedPrefixPenalty(a, b)))
}

export const SUGGESTION_THRESHOLD = 0.15
