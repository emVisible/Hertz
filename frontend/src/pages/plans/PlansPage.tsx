import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import {
  briefGroupsApi,
  briefsApi,
  buffsApi,
  crewsApi,
  depthsApi,
  plansApi,
  rolesApi,
  type Brief,
  type BriefGroup,
  type Buff,
  type Crew,
  type DepthLevel,
  type PhaseDef,
  type PhaseOrderItem,
  type Plan,
  type Role,
} from '../../api'
import { Badge, Button, Card, EmptyState, Icon, Input, Select, useToast } from '../../components/ui'
import { modelOptions, retryOptions, timeoutOptions } from '../../constants/llm'
import { phaseLabel as phaseLabel } from '../../i18n'
import { BuffsTab } from './BuffsTab'
import { DepthTab } from './DepthTab'
import { RolesTab } from './RolesTab'
import { TeamsTab } from './TeamsTab'

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

type LeftTab = 'plans' | 'phases' | 'briefs' | 'brief-groups' | 'roles' | 'crews' | 'buffs' | 'debuffs' | 'depths'

export function PlansPage() {
  const { t } = useTranslation()
  const toast = useToast()
  const queryClient = useQueryClient()

  const { data: plans = [] } = useQuery({ queryKey: ['plans'], queryFn: plansApi.list })
  const { data: crews = [] } = useQuery({ queryKey: ['crews'], queryFn: crewsApi.list })
  const { data: roles = [] } = useQuery({ queryKey: ['roles'], queryFn: rolesApi.list })
  const { data: buffs = [] } = useQuery({ queryKey: ['buffs'], queryFn: buffsApi.list })
  const { data: depths = [] } = useQuery({ queryKey: ['depths'], queryFn: depthsApi.list })
  const { data: briefs = [] } = useQuery({ queryKey: ['briefs'], queryFn: briefsApi.list })
  const { data: briefGroups = [] } = useQuery({ queryKey: ['brief-groups'], queryFn: briefGroupsApi.list })
  const { data: palette = [] } = useQuery({ queryKey: ['phases'], queryFn: plansApi.phases })

  const [tab, setTab] = useState<LeftTab>('plans')

  // ---- plan 状态 ----
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [mode, setMode] = useState<'text' | 'visual' | 'video'>('text')
  const [crewId, setCrewId] = useState('')
  const [briefId, setBriefId] = useState('')
  const [briefGroupId, setBriefGroupId] = useState('')
  const [planBuffKeys, setPlanBuffKeys] = useState<string[]>([])
  const [phaseOrder, setPhaseOrder] = useState<PhaseOrderItem[]>([])
  const [dirty, setDirty] = useState(false)

  // ---- brief 状态 ----
  const [briefSel, setBriefSel] = useState<string | null>(null)
  const [briefName, setBriefName] = useState('')
  const [briefContent, setBriefContent] = useState('')
  const [briefDirty, setBriefDirty] = useState(false)

  // ---- 策略组状态（v0.7）----
  const [groupSel, setGroupSel] = useState<string | null>(null)
  const [groupName, setGroupName] = useState('')
  const [groupDesc, setGroupDesc] = useState('')
  const [groupBriefIds, setGroupBriefIds] = useState<string[]>([])
  const [groupDirty, setGroupDirty] = useState(false)

  // ---- phase 状态 ----
  const [phaseSel, setPhaseSel] = useState<string | null>(null)
  const [phaseName, setPhaseName] = useState('')
  const [phaseDesc, setPhaseDesc] = useState('')
  const [phaseRole, setPhaseRole] = useState('')
  const [phaseMethod, setPhaseMethod] = useState('')
  const [phaseStyle, setPhaseStyle] = useState('')
  const [phaseModel, setPhaseModel] = useState('')
  const [phaseRetries, setPhaseRetries] = useState(0)
  const [phaseTimeout, setPhaseTimeout] = useState(300)
  const [phaseDirty, setPhaseDirty] = useState(false)

  // ---- 团队状态 ----
  const [crewSel, setCrewSel] = useState<string | null>(null)

  // ---- 角色库状态 ----
  const [roleSel, setRoleSel] = useState<string | null>(null)

  // ---- Buff 库状态 ----
  const [buffSel, setBuffSel] = useState<string | null>(null)
  const [debuffSel, setDebuffSel] = useState<string | null>(null)

  // ---- 深度库状态（v0.3.10）----
  const [depthSel, setDepthSel] = useState<string | null>(null)

  const selected = plans.find((p) => p.id === selectedId) ?? null
  const selectedBrief = briefs.find((b) => b.id === briefSel) ?? null
  const selectedPhase = palette.find((p) => p.key === phaseSel) ?? null

  // ================= Plans =================
  function loadPlan(plan: Plan | null) {
    if (!plan) {
      setSelectedId(null)
      return
    }
    setSelectedId(plan.id)
    setName(plan.name)
    setDescription(plan.description ?? '')
    setMode(plan.mode)
    setCrewId(plan.crew_id ?? '')
    setBriefId(plan.brief_id ?? '')
    setBriefGroupId(plan.brief_group_id ?? '')
    setPhaseOrder(plan.phase_order)
    setPlanBuffKeys(plan.buff_keys ?? [])
    setDirty(false)
  }

  async function createPlan() {
    try {
      const plan = await plansApi.create({ name: t('plans.new') })
      await queryClient.invalidateQueries({ queryKey: ['plans'] })
      setTab('plans')
      loadPlan(plan)
      setDirty(true)
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  // ---- 克隆 / 导出 / 导入（v0.4 D2）----
  async function clonePlan(plan: Plan) {
    try {
      const copy = await plansApi.clone(plan.id)
      await queryClient.invalidateQueries({ queryKey: ['plans'] })
      setTab('plans')
      loadPlan(copy)
      setDirty(true)
      toast(t('plans.cloned'), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  async function exportPlan(plan: Plan) {
    try {
      const payload = await plansApi.exportPlan(plan.id)
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `plan-${plan.name.replace(/[^\w\u4e00-\u9fa5-]+/g, '_')}.json`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  async function importPlan() {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'application/json'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      try {
        const payload = JSON.parse(await file.text())
        const plan = await plansApi.importPlan(payload)
        await queryClient.invalidateQueries({ queryKey: ['plans'] })
        setTab('plans')
        loadPlan(plan)
        toast(t('plans.imported'), 'success')
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error')
      }
    }
    input.click()
  }

  async function savePlan() {
    if (!selectedId) return
    try {
      const plan = await plansApi.update(selectedId, {
        name,
        description,
        mode,
        crew_id: crewId || null,
        brief_id: briefId || null,
        brief_group_id: briefGroupId || null,
        phase_order: phaseOrder,
        buff_keys: planBuffKeys,
      })
      await queryClient.invalidateQueries({ queryKey: ['plans'] })
      loadPlan(plan)
      toast(t('plans.saved'), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  async function removePlan(plan: Plan) {
    try {
      await plansApi.remove(plan.id)
      await queryClient.invalidateQueries({ queryKey: ['plans'] })
      if (selectedId === plan.id) loadPlan(null)
      toast(t('plans.deleted'), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  function addPhase(phase: PhaseDef) {
    if (phaseOrder.some((p) => p.key === phase.key)) return
    setPhaseOrder((prev) => [...prev, { key: phase.key, enabled: true, config: {} }])
    setDirty(true)
  }

  function removePhaseFromOrder(key: string) {
    setPhaseOrder((prev) => prev.filter((p) => p.key !== key))
    setDirty(true)
  }

  function togglePhase(key: string) {
    setPhaseOrder((prev) => prev.map((p) => (p.key === key ? { ...p, enabled: !p.enabled } : p)))
    setDirty(true)
  }

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    setPhaseOrder((prev) => {
      const from = prev.findIndex((p) => p.key === active.id)
      const to = prev.findIndex((p) => p.key === over.id)
      if (from < 0 || to < 0) return prev
      setDirty(true)
      return arrayMove(prev, from, to)
    })
  }

  const available = palette.filter((p) => !phaseOrder.some((item) => item.key === p.key))

  // 按分组聚合（研究 → 创作 → 分发 → 基础设施 的建议阅读/摆放顺序）
  const GROUP_ORDER = ['brief', 'create', 'distribute', 'infrastructure', 'research', 'custom']
  function grouped<T>(items: T[], pick: (x: T) => string): { group: string; items: T[] }[] {
    const map = new Map<string, T[]>()
    for (const it of items) {
      const g = pick(it)
      map.set(g, [...(map.get(g) ?? []), it])
    }
    return GROUP_ORDER.filter((g) => map.has(g)).map((g) => ({ group: g, items: map.get(g)! }))
  }

  function applyDefaultOrder() {
    const defaultOrder = [
      'build_brief', 'director', 'writer', 'visual_director',
      'editor', 'distribution', 'package',
    ]
    setPhaseOrder(
      defaultOrder
        .filter((key) => palette.some((p) => p.key === key))
        .map((key) => ({ key, enabled: true, config: {} })),
    )
    setDirty(true)
    toast(t('plans.defaultOrder'), 'success')
  }

  // ================= Briefs =================
  function loadBrief(brief: Brief | null) {
    if (!brief) {
      setBriefSel(null)
      return
    }
    setBriefSel(brief.id)
    setBriefName(brief.name)
    setBriefContent(brief.content ?? '')
    setBriefDirty(false)
  }

  async function createBrief() {
    try {
      const brief = await briefsApi.create({ name: t('briefs.new') })
      await queryClient.invalidateQueries({ queryKey: ['briefs'] })
      setTab('briefs')
      loadBrief(brief)
      setBriefDirty(true)
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  async function saveBrief() {
    if (!briefSel) return
    try {
      const brief = await briefsApi.update(briefSel, {
        name: briefName,
        content: briefContent,
      })
      await queryClient.invalidateQueries({ queryKey: ['briefs'] })
      loadBrief(brief)
      toast(t('briefs.saved'), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  async function removeBrief(brief: Brief) {
    try {
      await briefsApi.remove(brief.id)
      await queryClient.invalidateQueries({ queryKey: ['briefs'] })
      if (briefSel === brief.id) loadBrief(null)
      toast(t('briefs.deleted'), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  // ================= 策略组（v0.7，类比团队=角色集合） =================
  function loadGroup(group: BriefGroup | null) {
    if (!group) {
      setGroupSel(null)
      return
    }
    setGroupSel(group.id)
    setGroupName(group.name)
    setGroupDesc(group.description ?? '')
    setGroupBriefIds(group.brief_ids)
    setGroupDirty(false)
  }

  async function createGroup() {
    try {
      const group = await briefGroupsApi.create({ name: t('briefGroups.new') })
      await queryClient.invalidateQueries({ queryKey: ['brief-groups'] })
      setTab('brief-groups')
      loadGroup(group)
      setGroupDirty(true)
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  async function saveGroup() {
    if (!groupSel) return
    try {
      const group = await briefGroupsApi.update(groupSel, {
        name: groupName,
        description: groupDesc,
        brief_ids: groupBriefIds,
      })
      await queryClient.invalidateQueries({ queryKey: ['brief-groups'] })
      loadGroup(group)
      toast(t('briefs.saved'), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  async function removeGroup(group: BriefGroup) {
    if (!window.confirm(t('common.delete'))) return
    try {
      await briefGroupsApi.remove(group.id)
      await queryClient.invalidateQueries({ queryKey: ['brief-groups'] })
      if (groupSel === group.id) loadGroup(null)
      toast(t('briefs.deleted'), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const selectedGroup = briefGroups.find((g) => g.id === groupSel) ?? null

  // ================= 团队（TeamsTab 受控选择） =================
  function loadCrew(crew: Crew | null) {
    setCrewSel(crew ? crew.id : null)
  }

  async function createCrew() {
    try {
      const crew = await crewsApi.create({ name: t('teams.new') })
      await queryClient.invalidateQueries({ queryKey: ['crews'] })
      setTab('crews')
      setCrewSel(crew.id)
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  async function removeCrew(crew: Crew) {
    try {
      await crewsApi.remove(crew.id)
      await queryClient.invalidateQueries({ queryKey: ['crews'] })
      if (crewSel === crew.id) loadCrew(null)
      toast(t('teams.deleted'), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  // ---- 角色库 ----
  async function createRole() {
    try {
      const role = await rolesApi.create({ key: `role_${Date.now().toString(36)}`, name: t('roles.new') })
      await queryClient.invalidateQueries({ queryKey: ['roles'] })
      setTab('roles')
      setRoleSel(role.id)
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  async function removeRole(role: Role) {
    try {
      await rolesApi.remove(role.id)
      await queryClient.invalidateQueries({ queryKey: ['roles'] })
      if (roleSel === role.id) setRoleSel(null)
      toast(t('roles.deleted'), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  // ---- Buff 库 ----
  async function createBuff() {
    try {
      const buff = await buffsApi.create({
        key: `buff_${Date.now().toString(36)}`,
        name: t('buffs.new'),
      })
      await queryClient.invalidateQueries({ queryKey: ['buffs'] })
      setTab('buffs')
      setBuffSel(buff.id)
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  async function removeBuff(buff: Buff) {
    try {
      await buffsApi.remove(buff.id)
      await queryClient.invalidateQueries({ queryKey: ['buffs'] })
      if (buffSel === buff.id) setBuffSel(null)
      if (debuffSel === buff.id) setDebuffSel(null)
      toast(t('buffs.deleted'), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  async function createDebuff() {
    try {
      const buff = await buffsApi.create({
        key: `debuff_${Date.now().toString(36)}`,
        name: t('buffs.newDebuff'),
        polarity: 'debuff',
      })
      await queryClient.invalidateQueries({ queryKey: ['buffs'] })
      setTab('debuffs')
      setDebuffSel(buff.id)
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  // ---- 深度库 CRUD（v0.3.10）----
  async function createDepth() {
    try {
      const level = await depthsApi.create({
        key: `depth_${Date.now().toString(36)}`,
        name: t('depths.new'),
      })
      await queryClient.invalidateQueries({ queryKey: ['depths'] })
      setTab('depths')
      setDepthSel(level.id)
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  async function removeDepth(level: DepthLevel) {
    if (!window.confirm(t('common.delete'))) return
    try {
      await depthsApi.remove(level.id)
      await queryClient.invalidateQueries({ queryKey: ['depths'] })
      if (depthSel === level.id) setDepthSel(null)
      toast(t('buffs.deleted'), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  // ---- Phase CRUD ----
  function loadPhase(def: PhaseDef | null) {
    if (!def) {
      setPhaseSel(null)
      return
    }
    setPhaseSel(def.key)
    setPhaseName(def.name)
    setPhaseDesc(def.description ?? '')
    setPhaseRole(def.role ?? '')
    setPhaseMethod(def.method ?? '')
    setPhaseStyle(def.style?.join('\n') ?? '')
    setPhaseModel(def.model ?? '')
    setPhaseRetries(def.retries ?? 0)
    setPhaseTimeout(def.timeout ?? 300)
    setPhaseDirty(false)
  }

  async function createPhase() {
    try {
      const def = await plansApi.createPhase({ name: t('phases.new') })
      await queryClient.invalidateQueries({ queryKey: ['phases'] })
      setTab('phases')
      loadPhase(def)
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  async function savePhase() {
    if (!phaseSel) return
    try {
      await plansApi.updatePhase(phaseSel, {
        name: phaseName,
        description: phaseDesc,
        role: phaseRole,
        method: phaseMethod,
        style: phaseStyle.split('\n').map((s) => s.trim()).filter(Boolean),
        model: phaseModel,
        retries: phaseRetries,
        timeout: phaseTimeout,
      })
      await queryClient.invalidateQueries({ queryKey: ['phases'] })
      setPhaseDirty(false)
      toast(t('phases.saved'), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  async function removePhase(def: PhaseDef) {
    const ok = def.builtin
      ? window.confirm(t('phases.confirmRemoveBuiltin'))
      : window.confirm(t('common.delete'))
    if (!ok) return
    try {
      await plansApi.removePhase(def.key)
      await queryClient.invalidateQueries({ queryKey: ['phases'] })
      if (phaseSel === def.key) loadPhase(null)
      toast(t('phases.deleted'), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  async function restoreDefaults() {
    if (!window.confirm(t('phases.confirmRestore'))) return
    try {
      await plansApi.restorePhaseDefaults()
      await queryClient.invalidateQueries({ queryKey: ['phases'] })
      loadPhase(null)
      toast(t('phases.restoreDefault'), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  return (
    <div className="flex h-full overflow-hidden">
      <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-surface-1">
        {/* 编排：页面身份标题（当前页即编排，非可点击项） */}
        <div className="border-b border-border px-3 py-2.5">
          <div className="flex items-center gap-2">
            <Icon name="plans" size={14} className="text-primary" />
            <span className="text-sm font-semibold text-text-primary">{t('nav.plans')}</span>
          </div>
        </div>

        {/* 语义分组：配置 / 角色 / 增益（每组一行两列，激活组的行右侧显示简约贴纸） */}
        <div className="px-1 pb-1">
          {[
            {
              id: 'config',
              label: t('plans.groupConfig'),
              tabs: [
                { id: 'phases', label: t('phases.title') },
                { id: 'depths', label: t('depths.title') },
              ],
            },
            {
              id: 'strategy',
              label: t('plans.groupStrategy'),
              tabs: [
                { id: 'briefs', label: t('nav.briefs') },
                { id: 'brief-groups', label: t('briefGroups.title') },
              ],
            },
            {
              id: 'roles',
              label: t('plans.groupRoles'),
              tabs: [
                { id: 'roles', label: t('roles.title') },
                { id: 'crews', label: t('teams.title') },
              ],
            },
            {
              id: 'buffs',
              label: t('plans.groupBuffs'),
              tabs: [
                { id: 'buffs', label: t('buffs.title') },
                { id: 'debuffs', label: t('buffs.debuffTitle') },
              ],
            },
          ].map((group) => {
            const groupActive = group.tabs.some((it) => it.id === tab)
            return (
              <div key={group.id} className="flex items-center gap-1 py-0.5">
                <div className="grid min-w-0 flex-1 grid-cols-2">
                  {group.tabs.map((item, idx) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setTab(item.id as LeftTab)}
                      className={`border-l-2 px-2 py-1.5 text-left text-xs transition-colors ${
                        tab === item.id
                          ? 'border-primary bg-surface-2 text-text-primary'
                          : 'border-transparent text-text-secondary hover:bg-surface-2'
                      } ${idx === 0 ? 'border-r border-border' : ''}`}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                {groupActive && (
                  <span className="shrink-0 pl-1 text-[9px] font-medium tracking-[0.2em] text-text-disabled [writing-mode:vertical-rl]">
                    {group.label}
                  </span>
                )}
              </div>
            )
          })}
        </div>

        {/* 列表 */}
        <ul className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {tab === 'plans' && (
            <li className="flex flex-col gap-1 p-1">
              <Button className="w-full" onClick={createPlan}>
                <Icon name="plus" size={14} />
                {t('plans.new')}
              </Button>
              <button
                type="button"
                onClick={() => void importPlan()}
                className="flex w-full items-center justify-center gap-1.5 border border-border px-3 py-1.5 text-xs text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
              >
                <Icon name="downloads" size={12} />
                {t('plans.import')}
              </button>
            </li>
          )}
          {tab === 'phases' && (
            <li className="flex flex-col gap-1 p-1">
              <Button className="w-full" onClick={() => void createPhase()}>
                <Icon name="plus" size={14} />
                {t('phases.new')}
              </Button>
              <button
                type="button"
                onClick={() => void restoreDefaults()}
                className="flex w-full items-center justify-center gap-1.5 border border-border px-3 py-1.5 text-xs text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
              >
                <Icon name="refresh" size={12} />
                {t('phases.restoreDefault')}
              </button>
            </li>
          )}
          {tab === 'plans' &&
            plans.map((plan) => (
              <li key={plan.id}>
                <button
                  type="button"
                  onClick={() => loadPlan(plan)}
                  className={`flex w-full items-center justify-between gap-1 px-3 py-2 text-left text-sm transition-colors ${
                    selectedId === plan.id
                      ? 'bg-surface-2 text-text-primary'
                      : 'text-text-secondary hover:bg-surface-2/50'
                  }`}
                >
                  <span className="truncate">{plan.name}</span>
                  <span className="flex shrink-0 items-center gap-0.5">
                    <button
                      type="button"
                      aria-label={t('plans.clone')}
                      title={t('plans.clone')}
                      onClick={(e) => {
                        e.stopPropagation()
                        void clonePlan(plan)
                      }}
                      className="p-0.5 text-text-disabled hover:text-primary"
                    >
                      <Icon name="copy" size={12} />
                    </button>
                    <button
                      type="button"
                      aria-label={t('plans.export')}
                      title={t('plans.export')}
                      onClick={(e) => {
                        e.stopPropagation()
                        void exportPlan(plan)
                      }}
                      className="p-0.5 text-text-disabled hover:text-primary"
                    >
                      <Icon name="upload" size={12} />
                    </button>
                    <button
                      type="button"
                      aria-label={t('common.delete')}
                      onClick={(e) => {
                        e.stopPropagation()
                        void removePlan(plan)
                      }}
                      className="p-0.5 text-text-disabled hover:text-error"
                    >
                      <Icon name="trash" size={12} />
                    </button>
                  </span>
                </button>
              </li>
            ))}
          {tab === 'phases' &&
            palette.map((def) => (
              <li key={def.key}>
                <button
                  type="button"
                  onClick={() => loadPhase(def)}
                  className={`flex w-full items-center justify-between gap-1 px-3 py-2 text-left text-sm transition-colors ${
                    phaseSel === def.key
                      ? 'bg-surface-2 text-text-primary'
                      : 'text-text-secondary hover:bg-surface-2/50'
                  }`}
                >
                  <span className="truncate">
                    {def.name}
                    {def.builtin && <span className="ml-1 text-[10px] text-text-disabled">内置</span>}
                  </span>
                  <button
                    type="button"
                    aria-label={t('common.delete')}
                    onClick={(e) => {
                      e.stopPropagation()
                      void removePhase(def)
                    }}
                    className="shrink-0 p-0.5 text-text-disabled hover:text-error"
                  >
                    <Icon name="trash" size={12} />
                  </button>
                </button>
              </li>
            ))}
          {tab === 'roles' && (
            <li className="p-1">
              <Button className="w-full" onClick={() => void createRole()}>
                <Icon name="plus" size={14} />
                {t('roles.new')}
              </Button>
            </li>
          )}
          {tab === 'roles' &&
            roles.map((role) => (
              <li key={role.id}>
                <button
                  type="button"
                  onClick={() => setRoleSel(role.id)}
                  className={`flex w-full items-center justify-between gap-1 px-3 py-2 text-left text-sm transition-colors ${
                    roleSel === role.id
                      ? 'bg-surface-2 text-text-primary'
                      : 'text-text-secondary hover:bg-surface-2/50'
                  }`}
                >
                  <span className="truncate">{role.name}</span>
                  <button
                    type="button"
                    aria-label={t('common.delete')}
                    onClick={(e) => {
                      e.stopPropagation()
                      void removeRole(role)
                    }}
                    className="shrink-0 p-0.5 text-text-disabled hover:text-error"
                  >
                    <Icon name="trash" size={12} />
                  </button>
                </button>
              </li>
            ))}
          {tab === 'buffs' && (
            <li className="p-1">
              <Button className="w-full" onClick={() => void createBuff()}>
                <Icon name="plus" size={14} />
                {t('buffs.new')}
              </Button>
            </li>
          )}
          {tab === 'buffs' &&
            (() => {
              const stable = buffs.filter((b) => b.category === 'stable' && b.polarity === 'buff')
              const randomPool = buffs.filter((b) => b.category === 'random' && b.polarity === 'buff')
              const renderItem = (buff: Buff) => (
                <li key={buff.id}>
                  <button
                    type="button"
                    onClick={() => setBuffSel(buff.id)}
                    className={`flex w-full items-center justify-between gap-1 px-3 py-2 text-left text-sm transition-colors ${
                      buffSel === buff.id
                        ? 'bg-surface-2 text-text-primary'
                        : 'text-text-secondary hover:bg-surface-2/50'
                    }`}
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate">{buff.name}</span>
                      {buff.kind === 'heavy' && (
                        <span className="shrink-0 text-[9px] text-warning">heavy</span>
                      )}
                    </span>
                    <button
                      type="button"
                      aria-label={t('common.delete')}
                      onClick={(e) => {
                        e.stopPropagation()
                        void removeBuff(buff)
                      }}
                      className="shrink-0 p-0.5 text-text-disabled hover:text-error"
                    >
                      <Icon name="trash" size={12} />
                    </button>
                  </button>
                </li>
              )
              return (
                <>
                  {stable.length > 0 && (
                    <li className="px-3 pt-1 text-[10px] font-semibold uppercase tracking-wide text-text-disabled">
                      {t('buffs.catStable')}
                    </li>
                  )}
                  {stable.map(renderItem)}
                  {randomPool.length > 0 && (
                    <li className="px-3 pt-1 text-[10px] font-semibold uppercase tracking-wide text-text-disabled">
                      {t('buffs.catRandom')}
                    </li>
                  )}
                  {randomPool.map(renderItem)}
                </>
              )
            })()}
          {tab === 'debuffs' && (
            <li className="p-1">
              <Button className="w-full" onClick={() => void createDebuff()}>
                <Icon name="plus" size={14} />
                {t('buffs.newDebuff')}
              </Button>
            </li>
          )}
          {tab === 'debuffs' &&
            buffs
              .filter((b) => b.polarity === 'debuff')
              .map((buff) => (
                <li key={buff.id}>
                  <button
                    type="button"
                    onClick={() => setDebuffSel(buff.id)}
                    className={`flex w-full items-center justify-between gap-1 px-3 py-2 text-left text-sm transition-colors ${
                      debuffSel === buff.id
                        ? 'bg-surface-2 text-text-primary'
                        : 'text-text-secondary hover:bg-surface-2/50'
                    }`}
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate">{buff.name}</span>
                      {buff.kind === 'heavy' && (
                        <span className="shrink-0 text-[9px] text-text-disabled">heavy</span>
                      )}
                    </span>
                    <button
                      type="button"
                      aria-label={t('common.delete')}
                      onClick={(e) => {
                        e.stopPropagation()
                        void removeBuff(buff)
                      }}
                      className="shrink-0 p-0.5 text-text-disabled hover:text-error"
                    >
                      <Icon name="trash" size={12} />
                    </button>
                  </button>
                </li>
              ))}
          {tab === 'depths' && (
            <li className="p-1">
              <Button className="w-full" onClick={() => void createDepth()}>
                <Icon name="plus" size={14} />
                {t('depths.new')}
              </Button>
            </li>
          )}
          {tab === 'depths' &&
            depths.map((level) => (
              <li key={level.id}>
                <button
                  type="button"
                  onClick={() => setDepthSel(level.id)}
                  className={`flex w-full items-center justify-between gap-1 px-3 py-2 text-left text-sm transition-colors ${
                    depthSel === level.id
                      ? 'bg-surface-2 text-text-primary'
                      : 'text-text-secondary hover:bg-surface-2/50'
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate">{level.name}</span>
                    {level.builtin && (
                      <span className="shrink-0 text-[9px] text-text-disabled">{t('phases.builtin')}</span>
                    )}
                  </span>
                  <button
                    type="button"
                    aria-label={t('common.delete')}
                    onClick={(e) => {
                      e.stopPropagation()
                      void removeDepth(level)
                    }}
                    className="shrink-0 p-0.5 text-text-disabled hover:text-error"
                  >
                    <Icon name="trash" size={12} />
                  </button>
                </button>
              </li>
            ))}
          {tab === 'briefs' && (
            <li className="p-1">
              <Button className="w-full" onClick={() => void createBrief()}>
                <Icon name="plus" size={14} />
                {t('briefs.new')}
              </Button>
            </li>
          )}
          {tab === 'briefs' &&
            briefs.map((brief) => (
              <li key={brief.id}>
                <button
                  type="button"
                  onClick={() => loadBrief(brief)}
                  className={`flex w-full items-center justify-between gap-1 px-3 py-2 text-left text-sm transition-colors ${
                    briefSel === brief.id
                      ? 'bg-surface-2 text-text-primary'
                      : 'text-text-secondary hover:bg-surface-2/50'
                  }`}
                >
                  <span className="truncate">{brief.name}</span>
                  <button
                    type="button"
                    aria-label={t('common.delete')}
                    onClick={(e) => {
                      e.stopPropagation()
                      void removeBrief(brief)
                    }}
                    className="shrink-0 p-0.5 text-text-disabled hover:text-error"
                  >
                    <Icon name="trash" size={12} />
                  </button>
                </button>
              </li>
            ))}
          {tab === 'brief-groups' && (
            <li className="p-1">
              <Button className="w-full" onClick={() => void createGroup()}>
                <Icon name="plus" size={14} />
                {t('briefGroups.new')}
              </Button>
            </li>
          )}
          {tab === 'brief-groups' &&
            briefGroups.map((group) => (
              <li key={group.id}>
                <button
                  type="button"
                  onClick={() => loadGroup(group)}
                  className={`flex w-full items-center justify-between gap-1 px-3 py-2 text-left text-sm transition-colors ${
                    groupSel === group.id
                      ? 'bg-surface-2 text-text-primary'
                      : 'text-text-secondary hover:bg-surface-2/50'
                  }`}
                >
                  <span className="truncate">{group.name}</span>
                  <span className="shrink-0 text-[10px] text-text-disabled">
                    {group.brief_ids.length}
                  </span>
                  <button
                    type="button"
                    aria-label={t('common.delete')}
                    onClick={(e) => {
                      e.stopPropagation()
                      void removeGroup(group)
                    }}
                    className="shrink-0 p-0.5 text-text-disabled hover:text-error"
                  >
                    <Icon name="trash" size={12} />
                  </button>
                </button>
              </li>
            ))}
          {tab === 'crews' && (
            <li className="p-1">
              <Button className="w-full" onClick={() => void createCrew()}>
                <Icon name="plus" size={14} />
                {t('teams.new')}
              </Button>
            </li>
          )}
          {tab === 'crews' &&
            crews.map((crew) => (
              <li key={crew.id}>
                <button
                  type="button"
                  onClick={() => loadCrew(crew)}
                  className={`flex w-full flex-col gap-0.5 px-3 py-2 text-left text-sm transition-colors ${
                    crewSel === crew.id
                      ? 'bg-surface-2 text-text-primary'
                      : 'text-text-secondary hover:bg-surface-2/50'
                  }`}
                >
                  <span className="flex w-full items-center justify-between gap-1">
                    <span className="truncate">{crew.name}</span>
                    <button
                      type="button"
                      aria-label={t('common.delete')}
                      onClick={(e) => {
                        e.stopPropagation()
                        void removeCrew(crew)
                      }}
                      className="shrink-0 p-0.5 text-text-disabled hover:text-error"
                    >
                      <Icon name="trash" size={12} />
                    </button>
                  </span>
                  <span className="truncate text-[11px] text-text-disabled">
                    {crew.description || `${crew.role_keys?.length ?? 0} ${t('teams.members')}`}
                  </span>
                </button>
              </li>
            ))}
          {(tab === 'plans' && plans.length === 0) ||
          (tab === 'briefs' && briefs.length === 0) ||
          (tab === 'brief-groups' && briefGroups.length === 0) ||
          (tab === 'roles' && roles.length === 0) ||
          (tab === 'buffs' && buffs.filter((b) => b.polarity === 'buff').length === 0) ||
          (tab === 'debuffs' && buffs.filter((b) => b.polarity === 'debuff').length === 0) ||
          (tab === 'depths' && depths.length === 0) ||
          (tab === 'crews' && crews.length === 0) ? (
            <p className="px-3 py-4 text-center text-xs text-text-disabled">
              {tab === 'plans' ? t('plans.empty') : tab === 'briefs' ? t('briefs.empty') : tab === 'brief-groups' ? t('briefGroups.empty') : tab === 'roles' ? t('roles.empty') : tab === 'buffs' ? t('buffs.empty') : tab === 'debuffs' ? t('buffs.debuffEmpty') : tab === 'depths' ? t('depths.empty') : t('teams.empty')}
            </p>
          ) : null}
        </ul>
      </aside>

      <main className="flex min-w-0 flex-1 overflow-hidden p-4">
        {tab === 'plans' && !selected && (
          <div className="w-full">
            <EmptyState icon="plans" title={plans.length === 0 ? t('plans.empty') : t('plans.noSelection')} />
          </div>
        )}

        {tab === 'plans' && selected && (
          <div className="flex min-h-0 w-full flex-col gap-4 lg:flex-row">
            <Card className="flex w-full min-h-0 shrink-0 flex-col lg:w-80">
              <div className="flex flex-col gap-3">
                <Input label={t('plans.name')} value={name} onChange={(e) => { setName(e.target.value); setDirty(true) }} />
                <Input label={t('plans.description')} value={description} onChange={(e) => { setDescription(e.target.value); setDirty(true) }} />
                <Select
                  label={t('plans.mode')}
                  value={mode}
                  onChange={(e) => { setMode(e.target.value as 'text' | 'visual' | 'video'); setDirty(true) }}
                  options={[
                    { value: 'text', label: t('plans.modeText') },
                    { value: 'visual', label: t('plans.modeVisual') },
                    { value: 'video', label: t('plans.modeVideo') },
                  ]}
                />
                <Select
                  label={t('plans.crew')}
                  value={crewId}
                  onChange={(e) => { setCrewId(e.target.value); setDirty(true) }}
                  options={[
                    { value: '', label: t('plans.none') },
                    ...crews.map((c) => ({ value: c.id, label: c.name })),
                  ]}
                />
                <Select
                  label={t('plans.brief')}
                  value={briefId}
                  onChange={(e) => { setBriefId(e.target.value); setDirty(true) }}
                  options={[
                    { value: '', label: t('plans.none') },
                    ...briefs.map((b) => ({ value: b.id, label: b.name })),
                  ]}
                />
                {/* 策略组（v0.7）：组优先于单个 brief */}
                <Select
                  label={t('plans.briefGroup')}
                  value={briefGroupId}
                  onChange={(e) => { setBriefGroupId(e.target.value); setDirty(true) }}
                  options={[
                    { value: '', label: t('plans.none') },
                    ...briefGroups.map((g) => ({ value: g.id, label: g.name })),
                  ]}
                />
                {briefGroupId && (
                  <p className="-mt-1 text-[10px] text-text-disabled">
                    {t('plans.briefGroupPriority')}
                  </p>
                )}
                {/* 计划级 buff（v5.0）：运行时可覆盖 */}
                <div>
                  <p className="mb-1 text-xs font-medium text-text-secondary">{t('plans.buffs')}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {buffs.filter((b) => b.category === 'stable' && b.enabled && b.polarity === 'buff').map((buff) => {
                      const active = planBuffKeys.includes(buff.key)
                      return (
                        <button
                          key={buff.id}
                          type="button"
                          onClick={() => {
                            setPlanBuffKeys(
                              active
                                ? planBuffKeys.filter((k) => k !== buff.key)
                                : [...planBuffKeys, buff.key],
                            )
                            setDirty(true)
                          }}
                          title={buff.effect}
                          className={`border px-2 py-0.5 text-[11px] transition-colors ${
                            active
                              ? 'border-primary bg-primary/10 text-text-primary'
                              : 'border-border text-text-secondary hover:border-primary hover:text-primary'
                          }`}
                        >
                          {buff.name}
                        </button>
                      )
                    })}
                    {buffs.some((b) => b.category === 'random' && b.enabled) && (
                      <button
                        type="button"
                        onClick={() => {
                          const active = planBuffKeys.includes('random')
                          setPlanBuffKeys(
                            active ? planBuffKeys.filter((k) => k !== 'random') : [...planBuffKeys, 'random'],
                          )
                          setDirty(true)
                        }}
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
                        {buffs.filter((b) => b.polarity === 'debuff' && b.enabled).map((buff) => {
                          const active = planBuffKeys.includes(buff.key)
                          return (
                            <button
                              key={buff.id}
                              type="button"
                              onClick={() => {
                                setPlanBuffKeys(
                                  active
                                    ? planBuffKeys.filter((k) => k !== buff.key)
                                    : [...planBuffKeys, buff.key],
                                )
                                setDirty(true)
                              }}
                              title={buff.effect}
                              className={`border px-2 py-0.5 text-[11px] transition-colors ${
                                active
                                  ? 'border-primary bg-primary/10 text-text-primary'
                                  : 'border-border text-text-secondary hover:border-primary hover:text-primary'
                              }`}
                            >
                              {buff.name}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button onClick={savePlan} disabled={!dirty} className="flex-1">
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
                            onClick={() => addPhase(phase)}
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
                  onClick={applyDefaultOrder}
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
                        onToggle={() => togglePhase(item.key)}
                        onRemove={() => removePhaseFromOrder(item.key)}
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
        )}

        {tab === 'phases' && (
          <div className="flex w-full flex-col gap-3">
            {!phaseSel ? (
              <EmptyState icon="plans" title={t('phases.select')} />
            ) : (
              <>
                <div className="flex items-end gap-3">
                  <Input
                    label={t('phases.name')}
                    value={phaseName}
                    onChange={(e) => { setPhaseName(e.target.value); setPhaseDirty(true) }}
                    className="w-64"
                  />
                  {selectedPhase?.builtin ? (
                    <Badge tone="neutral">{t('phases.builtin')}</Badge>
                  ) : null}
                  <Button onClick={savePhase} disabled={!phaseDirty}>
                    <Icon name="check" size={14} />
                    {t('phases.save')}
                  </Button>
                </div>
                <Card padded={false}>
                  <div className="border-b border-border px-3 py-2">
                    <h2 className="text-sm font-semibold">{t('phases.info')}</h2>
                  </div>
                  <dl className="grid grid-cols-1 gap-1 p-3 text-xs sm:grid-cols-2">
                    <div className="flex gap-2">
                      <dt className="w-20 text-text-disabled">{t('phases.key')}</dt>
                      <dd className="font-mono text-text-primary">{phaseSel}</dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="w-20 text-text-disabled">{t('phases.type')}</dt>
                      <dd className="text-text-primary">{selectedPhase?.phase_type ?? selectedPhase?.type ?? 'agent'}</dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="w-20 text-text-disabled">{t('phases.output')}</dt>
                      <dd className="font-mono text-text-primary">
                        {selectedPhase?.output_file || (phaseSel.endsWith('.md') ? phaseSel : `${phaseSel}.md`)}
                      </dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="w-20 text-text-disabled">{t('phases.phaseGroup')}</dt>
                      <dd className="text-text-primary">{selectedPhase?.phase_group ?? 'custom'}</dd>
                    </div>
                  </dl>
                </Card>
                <Input
                  label={t('phases.description')}
                  value={phaseDesc}
                  onChange={(e) => { setPhaseDesc(e.target.value); setPhaseDirty(true) }}
                  placeholder={t('phases.descHint')}
                />
                {selectedPhase?.phase_type === 'agent' || selectedPhase?.type === 'agent' ? (
                  <Card padded={false} className="flex min-h-0 flex-1 flex-col">
                    <div className="flex items-center justify-between border-b border-border px-3 py-2">
                      <h2 className="text-sm font-semibold">{t('phases.agentConfig')}</h2>
                      <span className="text-xs text-text-disabled">{t('phases.agentHint')}</span>
                    </div>
                    <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-1 gap-3 p-3 md:grid-cols-2">
                      <Input
                        label={t('phases.role')}
                        value={phaseRole}
                        onChange={(e) => { setPhaseRole(e.target.value); setPhaseDirty(true) }}
                        placeholder={t('phases.roleHint')}
                      />
                      <Select
                        label={t('phases.model')}
                        value={phaseModel}
                        onChange={(e) => { setPhaseModel(e.target.value); setPhaseDirty(true) }}
                        options={[{ value: '', label: t('phases.modelDefault') }, ...modelOptions(phaseModel)]}
                      />
                      <div className="md:col-span-2">
                        <label className="mb-1 block text-xs font-medium text-text-secondary">
                          {t('phases.method')}
                          <span className="ml-2 text-text-disabled">{t('phases.methodHint')}</span>
                        </label>
                        <textarea
                          value={phaseMethod}
                          onChange={(e) => { setPhaseMethod(e.target.value); setPhaseDirty(true) }}
                          spellCheck={false}
                          rows={8}
                          className="w-full resize-y border border-border bg-surface-2/60 px-3 py-2 font-mono text-sm leading-relaxed text-text-primary outline-none placeholder:text-text-disabled focus:border-primary"
                          placeholder={t('phases.methodHint')}
                        />
                      </div>
                      <Input
                        label={t('phases.style')}
                        value={phaseStyle}
                        onChange={(e) => { setPhaseStyle(e.target.value); setPhaseDirty(true) }}
                        placeholder={t('phases.styleHint')}
                      />
                      <div className="flex items-end gap-3">
                        <Select
                          label={t('phases.retries')}
                          value={String(phaseRetries)}
                          onChange={(e) => { setPhaseRetries(Number(e.target.value) || 0); setPhaseDirty(true) }}
                          className="w-24"
                          options={retryOptions(phaseRetries)}
                        />
                        <Select
                          label={t('phases.timeout')}
                          value={String(phaseTimeout)}
                          onChange={(e) => { setPhaseTimeout(Number(e.target.value) || 300); setPhaseDirty(true) }}
                          className="w-28"
                          options={timeoutOptions(phaseTimeout)}
                        />
                      </div>
                    </div>
                  </Card>
                ) : null}
              </>
            )}
          </div>
        )}

        {tab === 'briefs' && !selectedBrief && (
          <div className="w-full">
            <EmptyState icon="briefs" title={briefs.length === 0 ? t('briefs.empty') : t('briefs.noSelection')} />
          </div>
        )}

        {/* 策略组管理（v0.7）：名称/描述 + 策略多选 + 组优先提示 */}
        {tab === 'brief-groups' && !selectedGroup && (
          <div className="w-full">
            <EmptyState
              icon="briefs"
              title={briefGroups.length === 0 ? t('briefGroups.empty') : t('briefs.noSelection')}
              description={t('briefGroups.hint')}
            />
          </div>
        )}

        {tab === 'brief-groups' && selectedGroup && (
          <div className="flex w-full flex-col gap-3">
            <div className="flex flex-wrap items-end gap-3">
              <Input
                label={t('briefGroups.name')}
                value={groupName}
                onChange={(e) => { setGroupName(e.target.value); setGroupDirty(true) }}
                className="w-64"
              />
              <Button onClick={saveGroup} disabled={!groupDirty}>
                <Icon name="check" size={14} />
                {t('briefs.save')}
              </Button>
            </div>
            <Input
              label={t('briefGroups.description')}
              value={groupDesc}
              onChange={(e) => { setGroupDesc(e.target.value); setGroupDirty(true) }}
              placeholder={t('briefGroups.descriptionHint')}
            />
            <Card padded={false} className="flex min-h-0 flex-1 flex-col">
              <div className="flex items-center justify-between border-b border-border px-3 py-2">
                <h2 className="text-sm font-semibold">{t('briefGroups.members')}</h2>
                <span className="text-xs text-text-disabled">
                  {t('briefGroups.membersHint', { n: groupBriefIds.length })}
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5 p-3">
                {briefs.length === 0 && (
                  <p className="text-xs text-text-disabled">{t('briefs.empty')}</p>
                )}
                {briefs.map((brief) => {
                  const active = groupBriefIds.includes(brief.id)
                  return (
                    <button
                      key={brief.id}
                      type="button"
                      onClick={() => {
                        setGroupBriefIds(
                          active
                            ? groupBriefIds.filter((id) => id !== brief.id)
                            : [...groupBriefIds, brief.id],
                        )
                        setGroupDirty(true)
                      }}
                      className={`border px-2 py-1 text-xs transition-colors ${
                        active
                          ? 'border-primary bg-primary/10 text-text-primary'
                          : 'border-border text-text-secondary hover:border-primary hover:text-primary'
                      }`}
                    >
                      {brief.name}
                    </button>
                  )
                })}
              </div>
            </Card>
            <p className="text-[10px] leading-relaxed text-text-disabled">
              {t('briefGroups.priorityHint')}
            </p>
          </div>
        )}

        {tab === 'briefs' && selectedBrief && (
          <div className="flex w-full flex-col gap-3">
            <div className="flex flex-wrap items-end gap-3">
              <Input
                label={t('briefs.name')}
                value={briefName}
                onChange={(e) => { setBriefName(e.target.value); setBriefDirty(true) }}
                className="w-64"
              />
              <Button onClick={saveBrief} disabled={!briefDirty}>
                <Icon name="check" size={14} />
                {t('briefs.save')}
              </Button>
            </div>
            <Card padded={false} className="flex min-h-0 flex-1 flex-col">
              <div className="flex items-center justify-between rounded-t border-b border-border px-3 py-2">
                <h2 className="text-sm font-semibold">{t('briefs.content')}</h2>
                <div className="flex items-center gap-3">
                  <span className="flex items-center gap-1 text-xs text-text-secondary">
                    <Icon name="edit" size={12} aria-hidden />
                    {t('briefs.raw')}
                  </span>
                  <span className="flex items-center gap-1 text-xs text-text-secondary">
                    <Icon name="eye" size={12} aria-hidden />
                    {t('briefs.preview')}
                  </span>
                  <span className="text-xs text-text-disabled">
                    {t('briefs.charCount', { count: briefContent.length })}
                  </span>
                </div>
              </div>
              <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-2">
                <textarea
                  value={briefContent}
                  onChange={(e) => { setBriefContent(e.target.value); setBriefDirty(true) }}
                  spellCheck={false}
                  className="min-h-0 resize-none overflow-y-auto bg-transparent p-3 font-mono text-sm leading-relaxed text-text-primary outline-none placeholder:text-text-disabled"
                  placeholder={t('briefs.placeholder')}
                />
                <div className="min-h-0 overflow-y-auto border-t border-border p-3 md:border-l md:border-t-0">
                  <div className="md-body">
                    <ReactMarkdown>{briefContent || t('briefs.placeholder')}</ReactMarkdown>
                  </div>
                </div>
              </div>
            </Card>
          </div>
        )}

        {tab === 'roles' && <RolesTab selectedId={roleSel} onSelect={setRoleSel} />}

        {tab === 'buffs' && <BuffsTab selectedId={buffSel} onSelect={setBuffSel} polarity="buff" />}

        {tab === 'debuffs' && <BuffsTab selectedId={debuffSel} onSelect={setDebuffSel} polarity="debuff" />}

        {tab === 'depths' && <DepthTab selectedId={depthSel} onSelect={setDepthSel} />}

        {tab === 'crews' && (
          <TeamsTab selectedId={crewSel} onSelect={setCrewSel} />
        )}
      </main>
    </div>
  )
}
