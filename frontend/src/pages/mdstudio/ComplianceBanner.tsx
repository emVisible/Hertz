/** 敏感词合规横幅——把内核里的合规发现，变成用户看得见的一行话。

## 为什么值得单独一个组件

它只管呈现与折叠两件事，但它守着一条判断——**没事别出声**。内核对
`BUILT_IN` 装载的词表做扫描，正常稿件下它必须完全不出现；一旦出现，说明真的
有事，那就要说清楚是哪几处、哪类、哪行。横幅本身不做记账，mdcore
`scanCompliance` 做记账，本组件只做展示与交互。

## 判据

① 无发现时横幅完全不出现（`null`）——与诊断横幅同纪律；
② 有发现时：条目含词、类别、行号、数量，忽略按钮调用 `onIgnore`；
③ 条目按词分组，数量汇总，第一行坐标可点；
④ 忽略某词后，该词从本次发现中消失（白名单透传）。
*/

import type { ComplianceFinding } from '@hertz/mdcore'
import { useState } from 'react'

/** 文案由宿主传入，与 `emptyHint` 同一路子（i18n 在宿主那一层） */
export interface ComplianceLabels {
  /** 摘要，`{{count}}` = 出现处数之和 */
  summary: string
  expand: string
  collapse: string
  /** 忽略某词，`{{term}}` = 被忽略的词 */
  ignore: string
  /** 每行类别名 */
  category: Record<string, string>
  /** 行号，`{{line}}` = 源码行（1 起） */
  line: string
}

export function ComplianceBanner({
  findings,
  labels,
  onIgnore,
  onJumpToLine,
}: {
  findings: ComplianceFinding[]
  labels: ComplianceLabels
  onIgnore: (term: string) => void
  onJumpToLine?: (line: number) => void
}) {
  const [open, setOpen] = useState(false)
  if (findings.length === 0) return null

  // 词为一级分组：同一词多处命中，汇总成一行（与诊断横幅合并策略一致）
  const grouped = new Map<string, ComplianceFinding[]>()
  for (const item of findings) {
    const seen = grouped.get(item.term)
    if (seen) seen.push(item)
    else grouped.set(item.term, [item])
  }
  const rows = [...grouped.entries()].sort((a, b) =>
    a[0].localeCompare(b[0], 'zh'),
  )

  return (
    <div
      data-testid="mdstudio-compliance"
      role="status"
      className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-[var(--hz-warn-border,var(--hz-border))] bg-[var(--hz-warn-bg,var(--hz-surface-2))] px-3 py-2 text-xs text-[var(--hz-text-secondary)]"
    >
      <span className="font-medium text-[var(--hz-text-primary)]">
        {labels.summary.replace('{{count}}', String(findings.length))}
      </span>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-[var(--hz-primary)] hover:underline"
      >
        {open ? labels.collapse : labels.expand}
      </button>
      {open ? (
        <ul className="w-full space-y-1 pt-1">
          {rows.map(([term, items]) => (
            <li key={term} className="flex items-center gap-2">
              <code className="rounded bg-[var(--hz-surface-2)] px-1 py-0.5 text-[10px]">
                {term}
              </code>
              <span className="text-[var(--hz-text-disabled)]">
                {labels.category[items[0].category] ?? items[0].category}
              </span>
              {items[0].line !== null ? (
                <button
                  type="button"
                  className="text-[var(--hz-primary)] hover:underline"
                  onClick={() => onJumpToLine?.(items[0].line)}
                >
                  {labels.line.replace('{{line}}', String(items[0].line + 1))}
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => onIgnore(term)}
                className="text-[var(--hz-text-disabled)] hover:text-[var(--hz-text-primary)] underline"
              >
                {labels.ignore.replace('{{term}}', term)}
              </button>
              {items.length > 1 ? (
                <span className="text-[var(--hz-text-disabled)]">
                  ×{items.length}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
