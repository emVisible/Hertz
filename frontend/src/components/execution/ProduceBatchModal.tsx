import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { PipelineItem, ProduceOptions } from '../../api/pipeline'
import { Button, Icon, Modal, useToast } from '../ui'
import {
  DEFAULT_PRODUCE_OPTIONS,
  normalizeOptions,
  ProduceOptionsPicker,
} from './ProduceOptionsPicker'

/** 批量生产方式设置（v0.3.3）：多选条目 → 统一生产方式模块组合。 */
export function ProduceBatchModal({
  open,
  onClose,
  items,
  onApply,
}: {
  open: boolean
  onClose: () => void
  items: PipelineItem[]
  onApply: (items: PipelineItem[], options: Partial<ProduceOptions>) => void
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [options, setOptions] = useState<ProduceOptions>({ ...DEFAULT_PRODUCE_OPTIONS })

  const list = useMemo(() => items, [items])

  function toggleAll() {
    setSelected((prev) => (prev.size === list.length ? new Set() : new Set(list.map((i) => i.id))))
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function apply() {
    const chosen = list.filter((i) => selected.has(i.id))
    if (chosen.length === 0) {
      toast(t('console.produce.batchEmpty'), 'warning')
      return
    }
    onApply(chosen, normalizeOptions(options))
    onClose()
    setSelected(new Set())
  }

  return (
    <Modal open={open} onClose={onClose} title={t('console.produce.batch')} width={520}>
      <div className="flex flex-col gap-3">
        <p className="text-xs text-text-disabled">{t('console.produce.batchHint')}</p>

        {/* 生产方式（应用到所有选中条目） */}
        <ProduceOptionsPicker value={options} onChange={setOptions} />

        {/* 条目多选 */}
        <div className="flex items-center justify-between border-b border-border/60 pb-1.5">
          <p className="text-xs font-medium text-text-primary">{t('console.produce.batchItems', { n: selected.size })}</p>
          <button type="button" onClick={toggleAll} className="text-[10px] text-text-secondary transition-colors hover:text-text-primary">
            {selected.size === list.length ? t('console.produce.deselectAll') : t('console.produce.selectAll')}
          </button>
        </div>
        <ul className="max-h-64 space-y-1 overflow-y-auto">
          {list.length === 0 && <p className="py-4 text-center text-xs text-text-disabled">{t('console.emptyPreReview')}</p>}
          {list.map((item) => {
            const on = selected.has(item.id)
            return (
              <li key={item.id} className="flex items-center gap-2 px-1">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => toggle(item.id)}
                  className="accent-primary"
                  aria-label={item.title}
                />
                <span className={`min-w-0 flex-1 truncate text-xs ${on ? 'text-text-primary' : 'text-text-secondary'}`}>
                  {item.title}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-text-disabled">{item.status}</span>
              </li>
            )
          })}
        </ul>

        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t('docs.cancel')}
          </Button>
          <Button size="sm" disabled={selected.size === 0} onClick={apply}>
            <Icon name="check" size={12} />
            {t('console.produce.batchApply', { n: selected.size })}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
