import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import type { PipelineItem, ProduceOptions } from '../../api/pipeline'
import { pipelineApi } from '../../api/pipeline'
import { Button, Icon, Input, Modal, Select, useToast } from '../ui'
import { itemStatusKey } from '../../core/itemLabels'
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

  // 优先级顺序（v0.26 运营面板）：HTML5 拖拽重排 → 落库 priority
  const [order, setOrder] = useState<string[]>([])
  const [dragId, setDragId] = useState<string | null>(null)
  const [savingPriority, setSavingPriority] = useState(false)
  useEffect(() => {
    if (open) {
      setOrder(items.map((i) => i.id))
      setDragId(null)
    }
  }, [open, items])
  const byId = new Map(items.map((i) => [i.id, i]))
  const list = order.map((id) => byId.get(id)).filter((i): i is PipelineItem => !!i)
  // 新入库条目（order 未覆盖时兜底追加，保持不丢）
  for (const i of items) {
    if (!order.includes(i.id)) list.push(i)
  }

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

  function onDragStart(id: string) {
    setDragId(id)
  }
  function onDragOver(e: React.DragEvent, id: string) {
    e.preventDefault()
    if (dragId === null || dragId === id) return
    setOrder((prev) => {
      const next = prev.filter((x) => x !== dragId)
      const at = next.indexOf(id)
      next.splice(at < 0 ? next.length : at, 0, dragId)
      return next
    })
    setDragId(id)
  }

  async function savePriority() {
    if (order.length === 0) return
    setSavingPriority(true)
    try {
      const res = await pipelineApi.setPriority(order)
      toast(t('console.produce.prioritySaved', { n: res.updated }), 'success')
      await queryClient.invalidateQueries({ queryKey: ['pipeline-queue'] })
      await queryClient.invalidateQueries({ queryKey: ['pipeline-stage'] })
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setSavingPriority(false)
    }
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

        {/* 条目多选 + 优先级排序（v0.26）：拖拽重排 → 保存优先级落库 */}
        <div className="flex items-center justify-between border-b border-border/60 pb-1.5">
          <p className="text-xs font-medium text-text-primary">{t('console.produce.batchItems', { n: selected.size })}</p>
          <span className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void savePriority()}
              disabled={savingPriority || order.length === 0}
              className="text-[10px] text-text-secondary transition-colors hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
              title={t('console.produce.priorityHint', '按当前顺序保存制作优先级，engine 取件优先')}
            >
              {t('console.produce.prioritySave', '保存优先级')}
            </button>
            <button type="button" onClick={toggleAll} className="text-[10px] text-text-secondary transition-colors hover:text-text-primary">
              {selected.size === list.length ? t('console.produce.deselectAll') : t('console.produce.selectAll')}
            </button>
          </span>
        </div>
        <ul className="max-h-64 space-y-1 overflow-y-auto">
          {list.length === 0 && <p className="py-4 text-center text-xs text-text-disabled">{t('console.emptyPreReview')}</p>}
          {list.map((item, idx) => {
            const on = selected.has(item.id)
            return (
              <li
                key={item.id}
                draggable
                onDragStart={() => onDragStart(item.id)}
                onDragOver={(e) => onDragOver(e, item.id)}
                onDragEnd={() => setDragId(null)}
                className={`flex items-center gap-2 px-1 ${dragId === item.id ? 'opacity-50' : ''}`}
              >
                <span
                  className="cursor-grab font-mono text-[10px] text-text-disabled active:cursor-grabbing"
                  title={t('console.produce.dragHint', '拖拽排序')}
                >
                  {idx + 1}
                </span>
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
                {(item.priority ?? 0) > 0 && (
                  <span className="shrink-0 rounded bg-primary/15 px-1 font-mono text-[10px] text-primary">
                    P{item.priority}
                  </span>
                )}
                <span className="shrink-0 text-[10px] text-text-disabled">
                  {t(itemStatusKey(item.status))}
                </span>
              </li>
            )
          })}
        </ul>

        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t('common.cancel')}
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
