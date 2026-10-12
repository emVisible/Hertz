import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { CompilationTransition } from '../../api/pipeline'
import { itemTypeKey } from '../../core/itemLabels'
import { Button, Icon, Input, Select, useToast } from '../ui'
import {
  LONG_COMPILATION_S,
  TRANSITION_PRESETS,
  useCompilationWorkspace,
} from '../../hooks/useCompilationWorkspace'
import { MediaThumb } from './PipelineStage'
import { TRANSITION_KEY_ORDER, useCompilationShortcuts } from '../../hooks/useCompilationShortcuts'

/** 秒 → `1:05` / `12:03`。编排面板里时长到处都是，格式统一比每处各写一遍好。 */
function fmtDuration(total: number | null): string {
  if (total == null) return '—'
  const s = Math.max(0, Math.round(total))
  const m = Math.floor(s / 60)
  return m > 0 ? `${m}:${String(s % 60).padStart(2, '0')}` : `${s}s`
}

/** 画幅徽标：横/竖 + 分辨率。混排预警让用户提前知道结果。 */
function FrameTag({ width, height }: { width: number | null; height: number | null }) {
  if (width == null || height == null) return null
  const portrait = width < height
  return (
    <span className="shrink-0 rounded border border-border px-1 font-mono text-[10px] text-text-secondary">
      {width}×{height} {portrait ? '竖' : '横'}
    </span>
  )
}

/**
 * 合集编排工作区（v0.35）——预处理页的一个**视图态**，不是弹窗。
 *
 * ## 为什么不是弹窗
 *
 * 实测两件事：Modal 写死 `max-h-[80vh]`（`ui/Modal.tsx`），而序列本身就要滚；
 * 素材池再套一层滚动区。于是「核心的视频 item 占比很小」——加宽弹窗也解决不了
 * 纵向空间。这里占满预处理的内容区：左池 320px 固定，序列拿走其余全部。
 *
 * ## 为什么是这个布局
 *
 * 参数（标题/片尾/时长/预警）收进顶栏与底栏而不是开第三栏——省下的 280px
 * 全部给序列。转场控件画在两张卡的**缝隙**里：那才是它作用的位置，比缩进
 * 小控件更符合直觉。
 */
export function CompilationWorkspace({
  onBack,
  onCreated,
}: {
  onBack: () => void
  onCreated: () => void
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const ws = useCompilationWorkspace()
  const [dragId, setDragId] = useState<string | null>(null)
  const [poolFilter, setPoolFilter] = useState('')

  const shortcuts = useCompilationShortcuts({
    clipIds: ws.clipIds,
    selected: ws.selected,
    enabled: true,
    onMove: ws.move,
    onRemove: ws.remove,
    onToggle: ws.toggle,
    onSelect: ws.setSelected,
    onSetTransition: (leftId, i) => ws.setGap(leftId, TRANSITION_KEY_ORDER[i]),
    onUndo: ws.undo,
    onRedo: ws.redo,
    onCreate: handleCreate,
    onBack: onBack,
  })

  const pool = poolFilter.trim()
    ? ws.pool.filter((s) => s.title.toLowerCase().includes(poolFilter.trim().toLowerCase()))
    : ws.pool

  async function handleCreate() {
    const ok = await ws.create()
    if (ok) {
      toast(t('console.compilation.created', { n: ws.clipIds.length }), 'success')
      onCreated()
    } else if (ws.error) {
      toast(ws.error, 'error')
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="compilation-workspace">
      {/* 顶栏：去向 + 标题 + 汇总 */}
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-3 py-2">
        <Button size="sm" variant="ghost" onClick={onBack} icon={<Icon name="chevron-left" size={12} />}>
          {t('console.compilation.back')}
        </Button>
        <span className="shrink-0 text-sm font-medium text-text-primary">
          {t('console.compilation.title')}
        </span>
        <Input
          value={ws.title}
          onChange={(e) => ws.setTitle(e.target.value)}
          placeholder={t('console.compilation.titlePlaceholder')}
          aria-label={t('console.compilation.titlePlaceholder')}
          className="max-w-xs"
        />
        <span className="ml-auto flex shrink-0 items-center gap-3 font-mono text-[11px] text-text-secondary">
          <span>{t('console.compilation.picked', { n: ws.clipIds.length })}</span>
          <span>{t('console.compilation.estimate', { s: fmtDuration(ws.estimate) })}</span>
          <span className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={ws.undo}
              disabled={!ws.canUndo}
              title={t('console.compilation.undo')}
              className="rounded px-1 hover:bg-surface-2 disabled:opacity-30"
            >
              <Icon name="undo" size={12} />
            </button>
            <button
              type="button"
              onClick={ws.redo}
              disabled={!ws.canRedo}
              title={t('console.compilation.redo')}
              className="rounded px-1 hover:bg-surface-2 disabled:opacity-30"
            >
              <Icon name="redo" size={12} />
            </button>
            <button
              type="button"
              onClick={() => shortcuts.setHelpOpen((v) => !v)}
              title={t('console.compilation.shortcuts')}
              className="rounded px-1 text-xs hover:bg-surface-2"
            >
              ?
            </button>
          </span>
        </span>
      </div>

      {ws.hasDraft && (
        <div className="shrink-0 border-b border-border bg-primary/5 px-3 py-1 text-[11px] text-text-secondary">
          {t('console.compilation.draftRestored')}{' '}
          <button type="button" onClick={ws.discardDraft} className="underline hover:text-text-primary">
            {t('console.compilation.draftDiscard')}
          </button>
        </div>
      )}

      {/* 主体：左池 + 序列 */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* 素材池 */}
        <div className="flex w-80 shrink-0 flex-col border-r border-border">
          <div className="shrink-0 space-y-1.5 p-2">
            <Input
              value={poolFilter}
              onChange={(e) => setPoolFilter(e.target.value)}
              placeholder={t('console.compilation.poolSearch')}
              aria-label={t('console.compilation.poolSearch')}
            />
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  const all = pool.every((s) => ws.clipIds.includes(s.id))
                  pool.forEach((s) => {
                    if (all) ws.toggle(s.id)
                    else if (!ws.clipIds.includes(s.id)) ws.toggle(s.id)
                  })
                }}
              >
                {t('console.compilation.selectAll')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => pool.forEach((s) => ws.toggle(s.id))}
              >
                {t('console.compilation.invert')}
              </Button>
            </div>
          </div>
          <ul className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
            {ws.isLoading && (
              <li className="py-3 text-center text-xs text-text-disabled">
                {t('console.compilation.loading')}
              </li>
            )}
            {!ws.isLoading && pool.length === 0 && (
              <li className="py-3 text-center text-xs text-text-disabled">
                {t('console.compilation.poolEmpty')}
              </li>
            )}
            {pool.map((s) => {
              const on = ws.clipIds.includes(s.id)
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => ws.toggle(s.id)}
                    className={`mb-1 flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-surface-2/50 ${
                      on ? 'bg-primary/10' : ''
                    }`}
                  >
                    <span className="w-16 shrink-0 overflow-hidden rounded-sm">
                      <MediaThumb
                        item={{ ...s, seq: null, status: 'downloaded' } as never}
                        className="aspect-video w-full"
                      />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs text-text-primary">{s.title}</span>
                      <span className="mt-0.5 flex items-center gap-1 text-[10px] text-text-secondary">
                        <span>{t(itemTypeKey(s.item_type))}</span>
                        {s.duration_s != null && <span>· {fmtDuration(s.duration_s)}</span>}
                      </span>
                    </span>
                    <Icon
                      name={on ? 'check' : 'plus'}
                      size={12}
                      className={on ? 'shrink-0 text-success' : 'shrink-0 text-text-disabled'}
                    />
                  </button>
                </li>
              )
            })}
          </ul>
        </div>

        {/* 序列 */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
            <span className="text-[10px] uppercase tracking-wide text-text-disabled">
              {t('console.compilation.sequence')}
            </span>
            {ws.clipIds.length > 1 && (
              <span className="ml-auto flex items-center gap-1">
                <span className="text-[10px] text-text-disabled">
                  {t('console.compilation.transitionAll')}
                </span>
                <Select
                  aria-label={t('console.compilation.transitionAll')}
                  value=""
                  onChange={(e) => {
                    if (e.target.value) ws.applyTransitionToAll(e.target.value as CompilationTransition)
                    e.target.value = ''
                  }}
                  options={[
                    { value: '', label: t('console.compilation.transitionAllPick') },
                    ...TRANSITION_PRESETS.map((p) => ({
                      value: p.value,
                      label: t(`console.compilation.transition_${p.value}`),
                    })),
                  ]}
                  className="w-28"
                />
              </span>
            )}
          </div>

          <ul className="min-h-0 flex-1 overflow-y-auto px-3 py-2" data-testid="compilation-sequence">
            {ws.chosen.length === 0 && (
              <li className="rounded-md border border-dashed border-border px-3 py-8 text-center text-xs text-text-disabled">
                {t('console.compilation.pickFirst')}
              </li>
            )}
            {ws.chosen.map((s, idx) => {
              const gap = idx > 0 ? ws.gaps[ws.clipIds[idx - 1]] : undefined
              const isSel = ws.selected === s.id
              return (
                <li key={s.id}>
                  <div
                    className={`flex items-center gap-3 rounded-md border px-2 py-2 ${
                      isSel ? 'border-primary bg-primary/5' : 'border-border'
                    }`}
                    onClick={() => ws.setSelected(s.id)}
                  >
                    <span
                      draggable
                      onDragStart={() => setDragId(s.id)}
                      onDragOver={(e) => {
                        e.preventDefault()
                        if (dragId) ws.reorderTo(dragId, s.id)
                      }}
                      onDragEnd={() => setDragId(null)}
                      className="cursor-grab text-text-disabled active:cursor-grabbing"
                      title={t('console.compilation.dragHint')}
                    >
                      <Icon name="grip" size={14} />
                    </span>
                    <span className="w-6 shrink-0 text-center font-mono text-xs text-text-disabled">
                      {idx + 1}
                    </span>
                    {/* 缩略图给足空间——这正是「item 占比太小」要解决的那件事 */}
                    <span className="w-40 shrink-0 overflow-hidden rounded-sm">
                      <MediaThumb
                        item={{ ...s, seq: null, status: 'downloaded' } as never}
                        className="aspect-video w-full"
                      />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-text-primary">{s.title}</span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-text-secondary">
                        <span>{t(itemTypeKey(s.item_type))}</span>
                        {s.duration_s != null && <span>· {fmtDuration(s.duration_s)}</span>}
                        <FrameTag width={s.width} height={s.height} />
                      </span>
                    </span>
                    <span className="flex shrink-0 flex-col gap-0.5">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          ws.move(s.id, -1)
                        }}
                        disabled={idx === 0}
                        className="text-text-disabled hover:text-text-primary disabled:opacity-30"
                        title={t('console.compilation.moveUp')}
                      >
                        <Icon name="chevron-up" size={12} />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          ws.move(s.id, 1)
                        }}
                        disabled={idx === ws.chosen.length - 1}
                        className="text-text-disabled hover:text-text-primary disabled:opacity-30"
                        title={t('console.compilation.moveDown')}
                      >
                        <Icon name="chevron-down" size={12} />
                      </button>
                    </span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        ws.remove(s.id)
                      }}
                      className="shrink-0 text-text-disabled hover:text-error"
                      title={t('common.delete')}
                    >
                      <Icon name="close" size={12} />
                    </button>
                  </div>

                  {/* 间隙转场：画在两张卡之间——那才是它作用的位置 */}
                  {idx < ws.chosen.length - 1 && (
                    <div className="flex items-center gap-1.5 py-1 pl-14">
                      <Icon name="grip" size={11} className="text-text-disabled" />
                      <Select
                        aria-label={t('console.compilation.transition')}
                        value={gap?.transition ?? 'cut'}
                        onChange={(e) => ws.setGap(s.id, e.target.value as CompilationTransition)}
                        options={TRANSITION_PRESETS.map((p) => ({
                          value: p.value,
                          label: t(`console.compilation.transition_${p.value}`),
                        }))}
                        className="w-28"
                      />
                      {(gap?.transition ?? 'cut') !== 'cut' && (
                        <Input
                          type="number"
                          step={0.1}
                          min={0.2}
                          max={3}
                          value={gap?.seconds ?? 0.6}
                          onChange={(e) => ws.setGapSeconds(s.id, Number(e.target.value))}
                          aria-label={t('console.compilation.transitionSeconds')}
                          className="w-16"
                        />
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>

          {/* 底栏：预警 + 主操作 */}
          <div className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-2">
            {ws.mixed && (
              <span className="text-[11px] text-warning">
                {t('console.compilation.warnMixedFrame')}
              </span>
            )}
            {ws.estimate != null && ws.estimate > LONG_COMPILATION_S && (
              <span className="text-[11px] text-warning">
                {t('console.compilation.warnTooLong')}
              </span>
            )}
            <span className="ml-auto">
              <Button size="sm" variant="ghost" onClick={onBack}>
                {t('common.cancel')}
              </Button>
            </span>
            <Button
              size="sm"
              loading={ws.saving}
              disabled={ws.clipIds.length === 0}
              onClick={handleCreate}
              icon={<Icon name="play" size={12} />}
            >
              {t('console.compilation.create')}
            </Button>
          </div>
        </div>
      </div>

      {shortcuts.helpOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={() => shortcuts.setHelpOpen(false)}
        >
          <div
            className="w-80 rounded-md border border-border bg-surface-1 p-3 text-xs"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2 flex items-center justify-between">
              <span className="font-medium text-text-primary">
                {t('console.compilation.shortcuts')}
              </span>
              <button type="button" onClick={() => shortcuts.setHelpOpen(false)}>
                <Icon name="close" size={12} />
              </button>
            </div>
            <ul className="space-y-1">
              {[
                ['↑ ↓ / J K', 'select'],
                ['⇧ ↑ ↓', 'moveUpDown'],
                ['Space', 'togglePick'],
                ['1…5', 'transitionGap'],
                ['Del', 'remove'],
                ['⌘/Ctrl + Z', 'undo'],
                ['⌘/Ctrl + ⇧ + Z', 'redo'],
                ['⌘/Ctrl + Enter', 'create'],
                ['Esc', 'back'],
              ].map(([k, label]) => (
                <li key={k} className="flex items-center justify-between">
                  <kbd className="rounded border border-border px-1 font-mono text-[10px]">{k}</kbd>
                  <span className="text-text-secondary">{t(`console.compilation.kb_${label}`)}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  )
}
