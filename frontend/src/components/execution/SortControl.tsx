import { useTranslation } from 'react-i18next'

import { Icon, Select } from '../ui'

/** 排序规格：要素 + 方向（v0.3.12 两维度分离，不再单下拉混排）。 */
export interface SortSpec {
  field: string
  dir: 'asc' | 'desc'
}

export interface SortField {
  id: string
  labelKey: string
}

/**
 * 通用排序控件（v0.3.12）：要素 Select + 升/降序切换。
 * 排序逻辑由调用方按 SortSpec 执行；组件只管声明与交互。
 */
export function SortControl({
  fields,
  sort,
  onSort,
  labelKey = 'console.sortLabel',
  className = 'w-36',
}: {
  fields: SortField[]
  sort: SortSpec
  onSort: (s: SortSpec) => void
  labelKey?: string
  className?: string
}) {
  const { t } = useTranslation()
  return (
    <span className="flex items-center gap-1.5">
      <Select
        aria-label={t(labelKey)}
        value={sort.field}
        onChange={(e) => onSort({ ...sort, field: e.target.value })}
        options={fields.map((f) => ({ value: f.id, label: t(f.labelKey) }))}
        className={className}
      />
      <button
        type="button"
        onClick={() => onSort({ ...sort, dir: sort.dir === 'asc' ? 'desc' : 'asc' })}
        title={t(sort.dir === 'asc' ? 'console.sortAsc' : 'console.sortDesc')}
        aria-label={t(sort.dir === 'asc' ? 'console.sortAsc' : 'console.sortDesc')}
        className="flex h-8 w-8 shrink-0 items-center justify-center border border-border text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
      >
        <Icon name={sort.dir === 'asc' ? 'sort-asc' : 'sort-desc'} size={14} />
      </button>
    </span>
  )
}
