import type { ReactNode } from 'react'

import { Badge, Card, type BadgeTone } from '../ui'

export interface HistoryItem {
  id: string
  title: string
  tone: BadgeTone
  statusLabel: string
  selected?: boolean
}

export interface HistoryListProps {
  title: string
  items: HistoryItem[]
  emptyText?: string
  onSelect: (id: string) => void
}

/**
 * 历史列表（Studio runs / Pipeline jobs 通用化）：状态徽章 + 选中高亮。
 */
export function HistoryList({ title, items, emptyText, onSelect }: HistoryListProps) {
  return (
    <Card padded={false} className="shrink-0">
      <div className="border-b border-border px-3 py-2">
        <h2 className="text-sm font-semibold">{title}</h2>
      </div>
      <ul className="max-h-44 space-y-0.5 overflow-y-auto p-2">
        {items.length === 0 && <p className="px-2 py-1 text-xs text-text-disabled">{emptyText ?? '—'}</p>}
        {items.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              onClick={() => onSelect(item.id)}
              className={`flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs transition-colors ${
                item.selected ? 'bg-surface-2' : 'hover:bg-surface-2/50'
              }`}
            >
              <Badge tone={item.tone}>{item.statusLabel}</Badge>
              <span className="truncate text-text-secondary">{item.title}</span>
            </button>
          </li>
        ))}
      </ul>
    </Card>
  )
}

export type { ReactNode }
