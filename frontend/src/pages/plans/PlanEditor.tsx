import { useTranslation } from 'react-i18next'
import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core'
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

import type { Buff, PhaseDef, PhaseOrderItem } from '../../api'
import { Badge, Button, Card, Icon, Input, Select } from '../../components/ui'
import { phaseLabel } from '../../i18n'

function SortablePhaseRow({
  item,
  index,
  group,
  onToggle,
  onRemove,
}: {
  item: PhaseOrderItem
  index: number
  group?: string
  onToggle: () => void
  onRemove: () => void
}) {
  const { t } = useTranslation()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.key,
  })
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex items-center gap-2 border px-3 py-2 ${
        isDragging ? 'border-primary bg-surface-2' : 'border-border bg-surface-1'
      }`}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={t('plans.dragHint')}
        className="cursor-grab p-0.5 text-text-disabled hover:text-text-secondary active:cursor-grabbing"
      >
        <Icon name="grip" size={14} />
      </button>
      <span className="w-6 shrink-0 text-center text-xs text-text-disabled">{index + 1}</span>
      <span className={`min-w-0 flex-1 truncate text-sm ${item.enabled ? '' : 'text-text-disabled line-through'}`}>
        {phaseLabel(t, item.key)}
      </span>
      {group && (
        <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-text-disabled">
          {t(`phaseGroups.${group}`, group)}
        </span>
      )}
      <Badge tone={item.enabled ? 'primary' : 'neutral'}>{item.enabled ? t('plans.enabled') : 'off'}</Badge>
      <button
        type="button"
        onClick={onToggle}
        className="p-1 text-text-secondary hover:bg-surface-2"
        aria-label={t('plans.enabled')}
      >
        <Icon name={item.enabled ? 'check' : 'close'} size={13} />
      </button>
      <button
        type="button"
        onClick={onRemove}
        className="p-1 text-text-disabled hover:text-error"
        aria-label={t('plans.remove')}
      >
        <Icon name="trash" size={13} />
      </button>
    </li>
  )
}

const GROUP_ORDER = ['brief', 'create', 'distribute', 'infrastructure', 'research', 'custom']

/** 计划编辑器（v0.8 拆分自 PlansPage）：基本信息 + buff/debuff + 调色板 + 工序排序。 */
export function PlanEditor({
  name,
  description,
  mode,
  crewId,
  briefId,
  briefGroupId,
  planBuffKeys,
  phaseOrder,
  crews,
  briefs,
  briefGroups,
  buffs,
  palette,
  dirty,
  onName,
  onDescription,
  onMode,
  onCrew,
  onBrief,
  onBriefGroup,
  onToggleBuff,
  onSave,
  onAddPhase,
  onRemovePhase,
  onTogglePhase,
  onReorder,
  onApplyDefaultOrder,
}: {
  name: string
  description: string
  mode: 'text' | 'visual' | 'video'
  crewId: string
  briefId: string
  briefGroupId: string
  planBuffKeys: string[]
  phaseOrder: PhaseOrderItem[]
  crews: Array<{ id: string; name: string }>
  briefs: Array<{ id: string; name: string }>
  briefGroups: Array<{ id: string; name: string }>
  buffs: Buff[]
  palette: PhaseDef[]
  dirty: boolean
  onName: (v: string) => void
  onDescription: (v: string) => void
  onMode: (v: 'text' | 'visual' | 'video') => void
  onCrew: (v: string) => void
  onBrief: (v: string) => void
  onBriefGroup: (v: string) => void
  onToggleBuff: (key: string) => void
  onSave: () => void
  onAddPhase: (phase: PhaseDef) => void
  onRemovePhase: (key: string) => void
  onTogglePhase: (key: string) => void
  onReorder: (from: string, to: string) => void
  onApplyDefaultOrder: () => void
}) {
  const { t } = useTranslation()

  function grouped<T>(items: T[], pick: (x: T) => string): { group: string; items: T[] }[] {
    const map = new Map<string, T[]>()
    for (const it of items) {
      const g = pick(it)
      map.set(g, [...(map.get(g) ?? []), it])
    }
    return GROUP_ORDER.filter((g) => map.has(g)).map((g) => ({ group: g, items: map.get(g)! }))
  }

  const available = palette.filter((p) => !phaseOrder.some((item) => item.key === p.key))

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    onReorder(String(active.id), String(over.id))
  }

  const buffPill = (buff: Buff, tone: 'primary' | 'warning') => {
    const active = planBuffKeys.includes(buff.key)
    return (
      <button
        key={buff.id}
        type="button"
        onClick={() => onToggleBuff(buff.key)}
        title={buff.effect}
        className={`border px-2 py-0.5 text-[11px] transition-colors ${
          active
            ? tone === 'warning'
              ? 'border-warning bg-warning/10 text-warning'
              : 'border-primary bg-primary/10 text-text-primary'
            : 'border-border text-text-secondary hover:border-primary hover:text-primary'
        }`}
      >
        {buff.name}
      </button>
    )
  }

  return (
    <div className="flex min-h-0 w-full flex-col gap-4 lg:flex-row">
      <Card className="flex w-full min-h-0 shrink-0 flex-col lg:w-80">
        <div className="flex flex-col gap-3">
          <Input label={t('plans.name')} value={name} onChange={(e) => onName(e.target.value)} />
          <Input
            label={t('plans.description')}
            value={description}
            onChange={(e) => onDescription(e.target.value)}
          />
          <Select
            label={t('plans.mode')}
            value={mode}
            onChange={(e) => onMode(e.target.value as 'text' | 'visual' | 'video')}
            options={[
              { value: 'text', label: t('plans.modeText') },
              { value: 'visual', label: t('plans.modeVisual') },
              { value: 'video', label: t('plans.modeVideo') },
            ]}
          />
          <Select
            label={t('plans.crew')}
            value={crewId}
            onChange={(e) => onCrew(e.target.value)}
            options={[{ value: '', label: t('plans.none') }, ...crews.map((c) => ({ value: c.id, label: c.name }))]}
          />
          <Select
            label={t('plans.brief')}
            value={briefId}
            onChange={(e) => onBrief(e.target.value)}
            options={[{ value: '', label: t('plans.none') }, ...briefs.map((b) => ({ value: b.id, label: b.name }))]}
          />
          {/* 策略组（v0.7）：组优先于单个 brief */}
          <Select
            label={t('plans.briefGroup')}
            value={briefGroupId}
            onChange={(e) => onBriefGroup(e.target.value)}
            options={[{ value: '', label: t('plans.none') }, ...briefGroups.map((g) => ({ value: g.id, label: g.name }))]}
          />
          {briefGroupId && (
            <p className="-mt-1 text-[10px] text-text-disabled">{t('plans.briefGroupPriority')}</p>
          )}
          {/* 计划级 buff（v5.0）：运行时可覆盖 */}
          <div>
            <p className="mb-1 text-xs font-medium text-text-secondary">{t('plans.buffs')}</p>
            <div className="flex flex-wrap gap-1.5">
              {buffs.filter((b) => b.category === 'stable' && b.enabled && b.polarity === 'buff').map((buff) => buffPill(buff, 'primary'))}
              {buffs.some((b) => b.category === 'random' && b.enabled) && (
                <button
                  type="button"
                  onClick={() => onToggleBuff('random')}
                  className={`border px-2 py-0.5 text-[11px] transition-colors ${
                    planBuffKeys.includes('random')
                      ? 'border-warning bg-warning/10 text-warning'
                      : 'border-border text-text-secondary hover:border-primary hover:text-primary'
                  }`}
                >
                  🎲 {t('buffs.catRandom')}
                </button>
              )}
            </div>
            {/* 计划级 debuff（v5.2）：反向禁忌 */}
            {buffs.some((b) => b.polarity === 'debuff' && b.enabled) && (
              <div className="mt-2">
                <p className="mb-1 text-xs font-medium text-text-secondary">{t('plans.debuffs')}</p>
                <div className="flex flex-wrap gap-1.5">
                  {buffs.filter((b) => b.polarity === 'debuff' && b.enabled).map((buff) => buffPill(buff, 'warning'))}
                </div>
              </div>
            )}
          </div>
          <div className="flex gap-2">
            <Button onClick={onSave} disabled={!dirty} className="flex-1">
              <Icon name="check" size={14} />
              {t('plans.save')}
            </Button>
          </div>
        </div>

        <h3 className="mb-2 mt-5 shrink-0 text-xs font-semibold uppercase tracking-wide text-text-secondary">
          {t('plans.palette')}
        </h3>
        <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto pb-1">
          {grouped(available, (p) => p.phase_group ?? 'custom').map(({ group, items }) => (
            <li key={group}>
              <p className="mb-0.5 px-1 pt-1 text-[10px] font-medium uppercase tracking-wider text-text-disabled">
                {t(`phaseGroups.${group}`, group)}
              </p>
              <ul className="space-y-1">
                {items.map((phase) => (
                  <li key={phase.key}>
                    <button
                      type="button"
                      onClick={() => onAddPhase(phase)}
                      className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
                    >
                      <Icon name="plus" size={12} />
                      <span className="truncate">{phaseLabel(t, phase.key)}</span>
                      <Badge tone={phase.type === 'system' ? 'neutral' : 'primary'}>{phase.type}</Badge>
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          ))}
          {available.length === 0 && (
            <p className="px-2 py-1 text-xs text-text-disabled">{t('plans.addPhase')}</p>
          )}
        </ul>
      </Card>

      <Card padded={false} className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <h2 className="text-sm font-semibold">
            {t('plans.phases')}
            <span className="ml-2 text-xs font-normal text-text-secondary">
              {phaseOrder.length} / {palette.length}
            </span>
          </h2>
          <button
            type="button"
            onClick={onApplyDefaultOrder}
            className="flex items-center gap-1.5 border border-border px-2 py-1 text-xs text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
          >
            <Icon name="refresh" size={12} />
            {t('plans.defaultOrder')}
          </button>
        </div>
        <DndContext collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={phaseOrder.map((p) => p.key)} strategy={verticalListSortingStrategy}>
            <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-3">
              {phaseOrder.map((item, index) => (
                <SortablePhaseRow
                  key={item.key}
                  item={item}
                  index={index}
                  group={palette.find((p) => p.key === item.key)?.phase_group}
                  onToggle={() => onTogglePhase(item.key)}
                  onRemove={() => onRemovePhase(item.key)}
                />
              ))}
              {phaseOrder.length === 0 && (
                <p className="px-2 py-4 text-center text-sm text-text-disabled">{t('plans.addPhase')}</p>
              )}
            </ul>
          </SortableContext>
        </DndContext>
      </Card>
    </div>
  )
}
