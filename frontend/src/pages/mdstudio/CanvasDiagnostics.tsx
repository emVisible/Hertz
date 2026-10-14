/**
 * 语法诊断横幅——把内核里那两本「没建模/没渲染」的账，变成用户看得见的一行话。
 *
 * 为什么值得单独一个组件：它自己只有呈现与折叠两件事，但它守着一条判断——
 * **没事别出声**。mdcore 现在把未建模语法集合守成空集（见 `ir/syntax-coverage.test.ts`），
 * 所以正常稿件下它必须完全不出现；一旦出现，说明真的有事，那就要说清楚是哪几处。
 */
import type { IRDiagnostic } from '@hertz/mdcore'
import { useState } from 'react'

/** 文案由宿主传入，与 `emptyHint` 同一路子（i18n 在宿主那一层） */
export interface DiagnosticsLabels {
  /** 摘要，`{{count}}` = 出现处数之和 */
  summary: string
  expand: string
  collapse: string
  /** 明细里的行号，`{{line}}` = 源码行（1 起） */
  line: string
  /** 同一语法合并后的次数，`{{count}}` */
  times: string
}

function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(vars[key] ?? ''))
}

export function DiagnosticsBanner({
  items,
  labels,
}: {
  items: IRDiagnostic[]
  labels: DiagnosticsLabels
}) {
  const [open, setOpen] = useState(false)
  if (items.length === 0) return null

  const total = items.reduce((sum, item) => sum + item.count, 0)
  // 解析层与渲染层可能报同一个 token（同一处语法，既没建模又没渲染分支）。
  // 合并成一条，免得同一行在清单里出现两次——那看着像 bug，本身就是 bug。
  const merged = new Map<string, IRDiagnostic>()
  for (const item of items) {
    const seen = merged.get(item.token)
    if (seen) {
      seen.count += item.count
      seen.line = seen.line ?? item.line
    } else {
      merged.set(item.token, { ...item })
    }
  }
  const rows = [...merged.values()].sort((a, b) => (a.line ?? Infinity) - (b.line ?? Infinity))

  return (
    <div
      data-testid="mdstudio-diagnostics"
      role="status"
      className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-[var(--hz-warn-border,var(--hz-border))] bg-[var(--hz-warn-bg,var(--hz-surface-2))] px-3 py-2 text-xs text-[var(--hz-text-secondary)]"
    >
      <span>{fill(labels.summary, { count: total })}</span>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-[var(--hz-primary)] hover:underline"
      >
        {open ? labels.collapse : labels.expand}
      </button>
      {open ? (
        <ul data-testid="mdstudio-diagnostics-list" className="w-full space-y-1 pt-1">
          {rows.map((row) => (
            <li key={row.token} className="flex items-center gap-2">
              <code className="rounded bg-[var(--hz-surface-2)] px-1">{row.token}</code>
              {row.line !== null ? (
                <span>{fill(labels.line, { line: row.line + 1 })}</span>
              ) : null}
              {row.count > 1 ? <span>{fill(labels.times, { count: row.count })}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}