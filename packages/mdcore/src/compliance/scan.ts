/** 敏感词扫描器核心（v0.37 P0-1）——纯数据函数，无副作用，零 DOM 依赖。

## 输入约定

源文是 Markdown 字符串；行号沿用 IRDiagnostic 的「0 起、`line`」语义，且只有
**源码行**，不用渲染后的行号。

## 走路线

1. 源文按 fenced code block 剥离内容（行数不变），配合正则匹配；
2. 每个词表条目 = 一个正则，匹配项之间用 `[\s·*\-_~]*` 分隔；
3. 正则找出所有匹配，记录（category / term / matched / 行号）；
4. 白名单过滤：`term` 或 `aliases` 中有任一在白名单里的，整个判定**豁免**；
5. 按行排序返回——交给 UI 渲染时直接复用与 diagnostics 一致的合并/跳转逻辑。

## 判据（成对变异过的）

① 清空本文件 `BUILT_IN` 装载 → 扫描断言红（词表不装，不叫不报）；
② `METAPHYSICS_LIST` 每词单测红；
③ 白名单豁免后同词不再报；
④ 清楚文本 / 合法稿 → 无发现，横幅完全不出现。
*/

import type { ComplianceFinding } from './types'
import { BUILT_IN, type ComplianceWord, type ComplianceWordlist as Wordlist } from './wordlists'

export interface ScanOptions {
  /** 免责词表。未传则不豁免。 */
  whitelist?: string[]
  /** 覆盖内置词表；默认使用 BUILT_IN。 */
  wordlists?: Wordlist[]
}

/** 两个字符之间允许插入的逃逸分隔符。 */
export const SEPARATOR = String.raw`[\s\u0020\u00B7\u002A\u002D\u005F\u007E]*`

/** 转义正则元字符。 */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 把一个词变成「字符间可带分隔符」的模式串。 */
export function patternFor(token: string): string {
  const parts = [...token].map(escapeRegExp)
  return parts.join(SEPARATOR)
}

/** 移除 fenced code block 内容，保持字符偏移不变（行号可沿用源码行号）。 */
export function stripCodeBlocks(sourceMd: string): string {
  const lines = sourceMd.split('\n')
  const out: string[] = []
  let inFence = false
  let marker = ''
  for (const line of lines) {
    const trimmed = line.trimStart()
    const fenceMatch = trimmed.match(/^(```|~~~)/)
    if (fenceMatch) {
      if (!inFence) {
        inFence = true
        marker = fenceMatch[1]
        out.push(line)
      } else if (trimmed.startsWith(marker)) {
        inFence = false
        out.push(line)
      } else {
        out.push(line)
      }
    } else if (inFence) {
      out.push(' '.repeat(line.length))
    } else {
      out.push(line)
    }
  }
  return out.join('\n')
}

function buildRegex(word: ComplianceWord): RegExp {
  const parts = [word.term, ...(word.aliases ?? [])].map(patternFor)
  return new RegExp(`(?:${parts.join('|')})`, 'gi')
}

function lineOf(text: string, index: number): number {
  let n = 0
  for (let i = 0; i < index; i += 1) {
    if (text.charCodeAt(i) === 0x0a) n += 1
  }
  return n
}

function isWhitelisted(word: ComplianceWord, set: ReadonlySet<string>): boolean {
  if (set.has(word.term)) return true
  return (word.aliases ?? []).some((alias) => set.has(alias))
}

export function scanCompliance(
  sourceMd: string,
  options: ScanOptions = {},
): ComplianceFinding[] {
  const { whitelist = [], wordlists = BUILT_IN } = options
  const whitelistSet = new Set(whitelist)
  const haystack = stripCodeBlocks(sourceMd)
  const findings: ComplianceFinding[] = []

  for (const wordlist of wordlists) {
    for (const raw of wordlist.terms) {
      const word = typeof raw === 'string' ? { term: raw } : raw
      if (isWhitelisted(word, whitelistSet)) continue
      const regex = buildRegex(word)
      let match: RegExpExecArray | null
      while ((match = regex.exec(haystack)) !== null) {
        findings.push({
          term: word.term,
          category: wordlist.category,
          matched: match[0],
          line: lineOf(haystack, match.index),
        })
        if (match[0].length === 0) regex.lastIndex += 1
      }
    }
  }

  findings.sort((a, b) =>
    a.line - b.line || a.term.localeCompare(b.term, 'zh'),
  )
  return findings
}
