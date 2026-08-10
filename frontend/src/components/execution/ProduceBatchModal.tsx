import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import type { PipelineItem, ProduceOptions } from '../../api/pipeline'
import { pipelineApi } from '../../api/pipeline'
import { Button, Icon, Input, Modal, Select, useToast } from '../ui'
import {
  DEFAULT_PRODUCE_OPTIONS,
  normalizeOptions,
  ProduceOptionsPicker,
} from './ProduceOptionsPicker'

/** 批量生产方式设置（v0.3.3）：多选条目 → 统一生产方式模块组合。
 *  v0.4 B3：顶部模板行——命名组合一键套用 / 当前组合存为模板。 */
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
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [options, setOptions] = useState<ProduceOptions>({ ...DEFAULT_PRODUCE_OPTIONS })
  const [templateId, setTemplateId] = useState('')
  const [templateName, setTemplateName] = useState('')

  const { data: templates = [] } = useQuery({
    queryKey: ['produce-templates'],
    queryFn: pipelineApi.produceTemplates,
  })

  const list = useMemo(() => items, [items])

  function applyTemplate(id: string) {
    const tpl = templates.find((x) => x.id === id)
    if (!tpl) return
    setOptions(normalizeOptions(tpl.options))
  }

  async function saveAsTemplate() {
    const name = templateName.trim()
    if (!name) {
      toast(t('console.produce.templateNameEmpty'), 'warning')
      return
    }
    try {
      await pipelineApi.createProduceTemplate(name, normalizeOptions(options))
      await queryClient.invalidateQueries({ queryKey: ['produce-templates'] })
      setTemplateName('')
      toast(t('console.produce.templateSaved'), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  async function removeTemplate(id: string) {
    if (!window.confirm(t('common.delete'))) return
    try {
      await pipelineApi.removeProduceTemplate(id)
      await queryClient.invalidateQueries({ queryKey: ['produce-templates'] })
      if (templateId === id) setTemplateId('')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

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

        {/* 模板行（v0.4 B3）：命名组合一键套用 + 存为模板 */}
        <div className="flex flex-wrap items-center gap-1.5">
          <Select
            aria-label={t('console.produce.template')}
            value={templateId}
            onChange={(e) => {
              setTemplateId(e.target.value)
              if (e.target.value) applyTemplate(e.target.value)
            }}
            options={[
              { value: '', label: t('console.produce.templateNone') },
              ...templates.map((x) => ({ value: x.id, label: x.name })),
            ]}
            className="w-40"
          />
          <span className="flex min-w-0 flex-1 items-center gap-1">
            <Input
              value={templateName}
              onChange={(e) => setTemplateName(e.target.value)}
              placeholder={t('console.produce.templateNamePlaceholder')}
              className="h-8 min-w-0 flex-1"
            />
            <Button size="sm" variant="secondary" onClick={() => void saveAsTemplate()}>
              <Icon name="plus" size={12} />
              {t('console.produce.templateSave')}
            </Button>
            {templateId && (
              <Button size="sm" variant="ghost" onClick={() => void removeTemplate(templateId)}>
                <Icon name="trash" size={12} />
              </Button>
            )}
          </span>
        </div>

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
