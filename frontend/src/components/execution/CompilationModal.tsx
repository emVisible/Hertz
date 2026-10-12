import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import type {
  CompilationClip,
  CompilationSource,
  CompilationTransition,
} from '../../api/pipeline'
import { pipelineApi } from '../../api/pipeline'
import { Badge, Button, Icon, Input, Modal, Select, useToast } from '../ui'
import { MediaThumb } from './PipelineStage'

/** 转场档位与默认时长。与后端 `assemble.TRANSITIONS` 同名同默认值——
 *  界面写中文、请求发英文档名，两边靠这张表对齐。 */
const TRANSITION_OPTIONS: Array<{
  value: CompilationTransition
  seconds: number
}> = [
  { value: 'cut', seconds: 0 },
  { value: 'fade', seconds: 0.6 },
  { value: 'wipe', seconds: 0.5 },
  { value: 'dissolve', seconds: 0.6 },
  { value: 'zoomin', seconds: 0.7 },
]
const DEFAULT_TRANSITION_S = 0.6

/** 单条合集的时长软上限（只警告不阻断——用户要长片时该让他做）。 */
const LONG_COMPILATION_S = 600

/** 编排面板（v0.35 多素材合集）：选片段 → 拖拽排序 → 逐间隙选转场 → 建条目。
 *
 *  产物是**一条新条目**（已下载未加工），源素材条目不受影响——它们仍留在
 *  列表里，可以被别的合集再次引用，也可以单独发。
 */
export function CompilationModal({
  open,
  onClose,
  initialIds,
}: {
  open: boolean
  onClose: () => void
  /** 从已下载列表多选带入的片段（空 = 从池子里挑） */
  initialIds?: string[]
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const queryClient = useQueryClient()
  const [title, setTitle] = useState('')
  const [clipIds, setClipIds] = useState<string[]>(() => [...(initialIds ?? [])])
  const [dragId, setDragId] = useState<string | null>(null)
  /** 间隙转场：键是「左片段 id」——转场发生在它与下一段之间。 */
  const [transitions, setTransitions] = useState<
    Record<string, { transition: CompilationTransition; seconds: number }>
  >({})
  const [outro, setOutro] = useState(false)
  const [saving, setSaving] = useState(false)

  const { data: pool = [], isLoading } = useQuery({
    queryKey: ['compilation-sources'],
    queryFn: pipelineApi.compilationSources,
    enabled: open,
  })

  // 初始化策略：**「打开即重建」**——调用方给 key（`compilationOpen ? 'open' : 'closed'`），
  // 面板每次打开都是全新的 state，不靠一串 effect 去重置。
  //
  // 之前是两个 effect（一个按 initialIds 播种、一个等 pool 到达后补种），
  // 两者靠 `clipIds.length > 0` 互斥，批处理下顺序不定 → 预选被补种覆盖。
  // 而 effect 的依赖一旦带上 pool / initialIds，调用方传内联数组字面量时
  // 引用每次渲染都变 → setState → 重渲染 → 再 setState 的无限循环，
  // 界面直接卡死（实测 vitest 整文件静默挂住，连第一条用例都不出现）。
  //
  // `seeded` 必须**声明在用它的 effect 之前**——反了就是 TDZ，effect 运行时
  // 抛错、状态更新被静默吞掉，表现为「池子有数据但序列区永远是空的」。
  const seeded = useRef(false)
  if (!open) seeded.current = false

  // 池子后到时给一次默认选择（仅当用户还没选过任何片段）。`seeded` 保证只发生
  // 一次——否则每次 pool 刷新（15s 轮询）都会重置用户的编排。
  useEffect(() => {
    if (!open || seeded.current || clipIds.length > 0 || pool.length === 0) return
    seeded.current = true
    setClipIds(pool.slice(0, 3).map((s) => s.id))
  }, [open, pool, clipIds.length])

  const byId = useMemo(
    () => new Map(pool.map((s) => [s.id, s])),
    [pool],
  )
  const chosen = clipIds.map((id) => byId.get(id)).filter((s): s is CompilationSource => !!s)

  // 时长预估：候选条目不带 duration（后端没探测），所以只在用户填了已知值时
  // 才准；否则显示「未知」而不是编一个数字——假的预估比没有更坏。
  const estimate = useMemo(() => {
    let total = 0
    let known = 0
    clipIds.forEach((id, idx) => {
      const dur = byId.get(id)?.duration_s
      if (dur) {
        total += dur
        known += 1
      }
      if (idx > 0) {
        const t = transitions[clipIds[idx - 1]]?.transition ?? 'cut'
        if (t !== 'cut') total -= transitions[clipIds[idx - 1]]?.seconds ?? DEFAULT_TRANSITION_S
      }
    })
    return { total, known, complete: known === clipIds.length && clipIds.length > 0 }
  }, [clipIds, byId, transitions])

  function toggle(id: string) {
    setClipIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  function onDragStart(id: string) {
    setDragId(id)
  }
  function onDragOver(e: React.DragEvent, id: string) {
    e.preventDefault()
    if (dragId === null || dragId === id) return
    setClipIds((prev) => {
      const next = prev.filter((x) => x !== dragId)
      const at = next.indexOf(id)
      next.splice(at < 0 ? next.length : at, 0, dragId)
      return next
    })
    setDragId(id)
  }

  function setGap(leftId: string, transition: CompilationTransition) {
    const preset = TRANSITION_OPTIONS.find((o) => o.value === transition)
    setTransitions((prev) => ({
      ...prev,
      [leftId]: { transition, seconds: prev[leftId]?.seconds || preset?.seconds || DEFAULT_TRANSITION_S },
    }))
  }
  function setGapSeconds(leftId: string, seconds: number) {
    setTransitions((prev) => ({
      ...prev,
      [leftId]: {
        transition: prev[leftId]?.transition ?? 'fade',
        seconds: Math.max(0.2, Math.min(3, seconds)),
      },
    }))
  }

  async function create() {
    if (clipIds.length === 0) {
      toast(t('console.compilation.noClips'), 'warning')
      return
    }
    const clips: CompilationClip[] = clipIds.map((id, idx) =>
      idx === 0
        ? { item_id: id }
        : {
            item_id: id,
            transition: transitions[clipIds[idx - 1]]?.transition ?? 'cut',
            transition_s: transitions[clipIds[idx - 1]]?.seconds ?? DEFAULT_TRANSITION_S,
          },
    )
    setSaving(true)
    try {
      const res = await pipelineApi.createCompilation({
        title: title.trim() || null,
        clips,
        outro: outro ? { enabled: true, duration_s: 2.5 } : null,
      })
      await queryClient.invalidateQueries({ queryKey: ['pipeline-stage'] })
      await queryClient.invalidateQueries({ queryKey: ['pipeline-queue'] })
      toast(t('console.compilation.created', { n: clips.length }), 'success')
      onClose()
      void res
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={t('console.compilation.title')} width={720}>
      <div className="flex flex-col gap-3">
        <p className="text-xs text-text-disabled">{t('console.compilation.hint')}</p>

        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t('console.compilation.titlePlaceholder')}
          aria-label={t('console.compilation.titlePlaceholder')}
        />

        {/* 片段池：可勾选加入。选中后进入下方编排区。 */}
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wide text-text-disabled">
              {t('console.compilation.pool')}
            </span>
            <span className="font-mono text-[10px] text-text-secondary">
              {t('console.compilation.picked', { n: clipIds.length })}
            </span>
          </div>
          <ul
            data-testid="compilation-pool"
            className="max-h-32 space-y-0.5 overflow-y-auto rounded-md border border-border p-1"
          >
            {isLoading && (
              <li className="py-3 text-center text-xs text-text-disabled">
                {t('console.compilation.loading')}
              </li>
            )}
            {!isLoading && pool.length === 0 && (
              <li className="py-3 text-center text-xs text-text-disabled">
                {t('console.compilation.poolEmpty')}
              </li>
            )}
            {pool.map((s) => {
              const on = clipIds.includes(s.id)
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => toggle(s.id)}
                    className={`flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-xs hover:bg-surface-2/50 ${
                      on ? 'bg-primary/10' : ''
                    }`}
                  >
                    <Icon
                      name={on ? 'check' : 'plus'}
                      size={11}
                      className={on ? 'text-success' : 'text-text-disabled'}
                    />
                    <span className="w-20 shrink-0 overflow-hidden">
                      <MediaThumb item={{ ...s, seq: null, status: 'downloaded' } as never} className="h-6 w-full" />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-text-primary">{s.title}</span>
                    <Badge tone="neutral">{s.item_type}</Badge>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>

        {/* 编排区：顺序 + 逐间隙转场 */}
        <div data-testid="compilation-sequence">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wide text-text-disabled">
              {t('console.compilation.sequence')}
            </span>
            {estimate.complete && (
              <span
                className={`font-mono text-[10px] ${
                  estimate.total > LONG_COMPILATION_S ? 'text-warning' : 'text-text-secondary'
                }`}
              >
                {t('console.compilation.estimate', { s: Math.round(estimate.total) })}
                {estimate.total > LONG_COMPILATION_S && (
                  <span className="ml-1 text-warning">{t('console.compilation.tooLong')}</span>
                )}
              </span>
            )}
          </div>
          {chosen.length === 0 ? (
            <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-text-disabled">
              {t('console.compilation.pickFirst')}
            </p>
          ) : (
            <ul className="space-y-1">
              {chosen.map((s, idx) => (
                <li key={s.id}>
                  <div
                    className={`flex items-center gap-2 rounded px-1.5 py-1 ${
                      dragId === s.id ? 'opacity-50' : ''
                    } ${idx > 0 ? 'border-t border-border/40' : ''}`}
                  >
                    <span
                      draggable
                      onDragStart={() => onDragStart(s.id)}
                      onDragOver={(e) => onDragOver(e, s.id)}
                      onDragEnd={() => setDragId(null)}
                      className="cursor-grab font-mono text-[10px] text-text-disabled active:cursor-grabbing"
                      title={t('console.compilation.dragHint')}
                    >
                      {idx + 1}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs text-text-primary">
                      {s.title}
                    </span>
                    <button
                      type="button"
                      onClick={() => toggle(s.id)}
                      className="shrink-0 text-text-disabled hover:text-error"
                      title={t('common.delete')}
                    >
                      <Icon name="close" size={12} />
                    </button>
                  </div>
                  {/* 间隙转场：画在「这一段」的下方，表示它与下一段之间 */}
                  {idx < chosen.length - 1 && (
                    <div className="flex items-center gap-1.5 py-1 pl-7">
                      <span className="text-[10px] text-text-disabled">
                        {t('console.compilation.gap')}
                      </span>
                      <Select
                        aria-label={t('console.compilation.transition')}
                        value={transitions[s.id]?.transition ?? 'cut'}
                        onChange={(e) => setGap(s.id, e.target.value as CompilationTransition)}
                        options={TRANSITION_OPTIONS.map((o) => ({
                          value: o.value,
                          label: t(`console.compilation.transition_${o.value}`),
                        }))}
                        className="w-24"
                      />
                      {(transitions[s.id]?.transition ?? 'cut') !== 'cut' && (
                        <Input
                          type="number"
                          step={0.1}
                          min={0.2}
                          max={3}
                          value={transitions[s.id]?.seconds ?? DEFAULT_TRANSITION_S}
                          onChange={(e) => setGapSeconds(s.id, Number(e.target.value))}
                          aria-label={t('console.compilation.transitionSeconds')}
                          className="w-16"
                        />
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* 片尾 */}
        <label className="flex items-center gap-2 text-xs text-text-secondary">
          <input
            type="checkbox"
            checked={outro}
            onChange={(e) => setOutro(e.target.checked)}
            className="accent-primary"
          />
          {t('console.compilation.outro')}
        </label>

        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            size="sm"
            loading={saving}
            disabled={clipIds.length === 0}
            onClick={create}
            icon={<Icon name="play" size={12} />}
          >
            {t('console.compilation.create')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}