import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { CompilationSource, CompilationTransition } from '../../api/pipeline'
import { itemTypeKey } from '../../core/itemLabels'
import { Button, Icon, Input, Select, useToast } from '../ui'
import {
  DEFAULT_TRANSITION_S,
  LONG_COMPILATION_S,
  MAX_TRANSITION_S,
  MIN_TRANSITION_S,
  TRANSITION_PRESETS,
  gapKey,
  useCompilationWorkspace,
} from '../../hooks/useCompilationWorkspace'
import { MediaThumb } from './PipelineStage'
import { TRANSITION_KEY_ORDER, useCompilationShortcuts } from '../../hooks/useCompilationShortcuts'

/** 快捷键面板的内容。导出供测试断言「面板里每个 label 都有 i18n 键」——
 *  v0.36 就因为这张表里的 kb_undo/kb_redo 两个键从没进过语言文件，
 *  面板直接把 `console.compilation.kb_undo` 字面量渲染给了用户。 */
export const SHORTCUT_ROWS: ReadonlyArray<readonly [string, string]> = [
  ['↑ ↓ / J K', 'select'],
  ['⇧ ↑ ↓', 'moveUpDown'],
  ['Space', 'togglePick'],
  ['1…5', 'transitionGap'],
  ['Del', 'remove'],
  ['⌘/Ctrl + Z', 'undo'],
  ['⌘/Ctrl + ⇧ + Z', 'redo'],
  ['⌘/Ctrl + Enter', 'create'],
  ['Esc', 'back'],
]

/** 秒 → `1:05` / `12:03`。编排面板里时长到处都是，格式统一比每处各写一遍好。 */
function fmtDuration(total: number | null): string {
  if (total == null) return '—'
  const s = Math.max(0, Math.round(total))
  const m = Math.floor(s / 60)
  return m > 0 ? `${m}:${String(s % 60).padStart(2, '0')}` : `${s}s`
}

/**
 * 画幅徽标：横/竖 + 分辨率 + **与首片不一致时的显式标注**。
 *
 * 分辨率写成 `480×854` 只在用户熟悉像素数时才有意义。混排时真正要回答的是
 * 「这条会不会出黑边」——那取决于它和**首片**的朝向是否一致，所以 `expectPortrait`
 * 传进来后不一致就直接标出「与首片相反」，用户不必自己心算。
 */
function FrameTag({
  width,
  height,
  expectPortrait,
}: {
  width: number | null
  height: number | null
  expectPortrait?: boolean | null
}) {
  if (width == null || height == null) return null
  const portrait = width < height
  const clashes = expectPortrait != null && expectPortrait !== portrait
  return (
    <span
      className={`shrink-0 rounded border px-1 font-mono text-[10px] ${
        clashes
          ? 'border-warning/60 bg-warning/10 text-warning'
          : 'border-border text-text-secondary'
      }`}
      title={
        clashes
          ? `${width}×${height} · 与首片朝向相反，合成后该片会被补黑边`
          : `${width}×${height}`
      }
    >
      {portrait ? '竖' : '横'} {width}×{height}
    </span>
  )
}

/**
 * 素材池（左侧）。
 *
 * 每条都带 `FrameTag` 并可对首片朝向做对比——混排预警如果只在底部写一句话，
 * 用户得自己在这一堆缩略图里找出「哪几条是反着的」。让比例显示直接出现在
 * 该看的地方，比让用户心算有用。
 */
function PoolPanel({
  pool,
  filter,
  onFilter,
  clipIds,
  loading,
  firstPortrait,
  onToggle,
  onSelectAll,
  onInvert,
}: {
  pool: CompilationSource[]
  filter: string
  onFilter: (v: string) => void
  clipIds: string[]
  loading: boolean
  firstPortrait: boolean | null
  onToggle: (id: string) => void
  onSelectAll: () => void
  onInvert: () => void
}) {
  const { t } = useTranslation()
  const inSequence = useMemo(() => new Set(clipIds), [clipIds])

  return (
    <div className="flex w-80 shrink-0 flex-col border-r border-border">
      <div className="shrink-0 space-y-1.5 p-2">
        <Input
          value={filter}
          onChange={(e) => onFilter(e.target.value)}
          placeholder={t('console.compilation.poolSearch')}
          aria-label={t('console.compilation.poolSearch')}
        />
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={onSelectAll}>
            {t('console.compilation.selectAll')}
          </Button>
          <Button size="sm" variant="ghost" onClick={onInvert}>
            {t('console.compilation.invert')}
          </Button>
        </div>
      </div>
      <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-1 pb-2">
        {loading && (
          <li className="py-3 text-center text-xs text-text-disabled">
            {t('console.compilation.loading')}
          </li>
        )}
        {!loading && pool.length === 0 && (
          <li className="py-3 text-center text-xs text-text-disabled">
            {t('console.compilation.poolEmpty')}
          </li>
        )}
        {pool.map((s) => {
          const on = inSequence.has(s.id)
          return (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => onToggle(s.id)}
                className={`flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-surface-2/50 ${
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
                  <span className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px]">
                    <span className="text-text-secondary">{t(itemTypeKey(s.item_type))}</span>
                    {s.duration_s != null && (
                      <span className="font-mono text-text-secondary">{fmtDuration(s.duration_s)}</span>
                    )}
                    <FrameTag
                      width={s.width}
                      height={s.height}
                      expectPortrait={on ? firstPortrait : null}
                    />
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
  )
}

/**
 * 序列里的一行 = 一个素材的**独立 container**（v0.37）。
 *
 * ## 为什么操作收进卡里，而不是散在卡与卡之间
 *
 * 之前转场控件是画在两张卡**之间**的一条独立行，归属靠 `idx-1` 推算。
 * 这就是 v0.37 那个错位 bug 的温床：控件读的是「本卡之前」，写的却是「本卡之后」。
 *
 * 现在转场是**这张卡自己的属性**——「进入本片的转场」，和缩略图、标题、删除按钮
 * 在同一个 container 里。归属是结构性的，不用算；序号变了控件也跟着走，
 * 不存在「控件留在原地、素材被换走」的情况。
 *
 * ## 拖拽插入点
 *
 * 按指针落在行的上半还是下半决定插入到前面还是后面——只有上下两个 hint 的话，
 * 拖到「两条之间」时用户无法表达想插哪一侧。
 */
function SequenceRow({
  id,
  idx,
  source,
  state,
  selected,
  gap,
  firstPortrait,
  dropHint,
  dragging,
  onSelect,
  onRemove,
  onGap,
  onGapSeconds,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
}: {
  id: string
  idx: number
  source: CompilationSource | null
  state: 'ready' | 'loading' | 'missing'
  selected: boolean
  gap?: { transition: CompilationTransition; seconds: number }
  firstPortrait: boolean | null
  /** null=无提示；true=插到其后；false=插到其前 */
  dropHint: boolean | null
  dragging: boolean
  onSelect: () => void
  onRemove: () => void
  onGap: (transition: CompilationTransition) => void
  onGapSeconds: (seconds: number) => void
  onDragStart: () => void
  onDragEnd: () => void
  onDragOver: (after: boolean) => void
  onDragLeave: () => void
}) {
  const { t } = useTranslation()
  const ref = useRef<HTMLLIElement>(null)

  return (
    <li
      ref={ref}
      className={`relative rounded-md border bg-surface-1 transition-colors ${
        selected ? 'border-primary' : 'border-border'
      } ${dragging ? 'opacity-40' : ''}`}
      onClick={onSelect}
      onDragOver={(e) => {
        e.preventDefault()
        const box = ref.current?.getBoundingClientRect()
        // 上半 = 插到前面，下半 = 插到后面
        onDragOver(box ? e.clientY > box.top + box.height / 2 : false)
      }}
      onDragLeave={onDragLeave}
      onDrop={(e) => {
        e.preventDefault()
        onDragEnd()
      }}
    >
      {/* 插入提示线：只画在指针所在的一侧 */}
      {dropHint !== null && (
        <span
          className={`pointer-events-none absolute left-0 right-0 h-0.5 bg-primary ${
            dropHint ? '-bottom-px' : '-top-px'
          }`}
        />
      )}

      <div className="flex items-center gap-3 p-2">
        <span
          draggable
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          className="shrink-0 cursor-grab text-text-disabled active:cursor-grabbing"
          title={t('console.compilation.dragHint')}
        >
          <Icon name="grip" size={14} />
        </span>
        <span className="w-6 shrink-0 text-center font-mono text-xs text-text-disabled">
          {idx + 1}
        </span>

        {/* 源缺失时仍然占住自己的位置：下标必须等于序号，否则间隙键会错 */}
        {source ? (
          <span className="w-40 shrink-0 overflow-hidden rounded-sm">
            <MediaThumb
              item={{ ...source, seq: null, status: 'downloaded' } as never}
              className="aspect-video w-full"
            />
          </span>
        ) : (
          <span className="flex h-[90px] w-40 shrink-0 items-center justify-center rounded-sm border border-dashed border-border text-[10px] text-text-disabled">
            {/* 加载中就说加载中。此前一律显示「源已移除」，等于在候选列表
                还没查回来时就替用户断言他的文件没了。 */}
            {state === 'loading' ? t('console.compilation.sourceLoading') : t('console.compilation.sourceMissing')}
          </span>
        )}

        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-text-primary">
            {source?.title ?? id}
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-text-secondary">
            {source && <span>{t(itemTypeKey(source.item_type))}</span>}
            {source?.duration_s != null && <span>· {fmtDuration(source.duration_s)}</span>}
            <FrameTag
              width={source?.width ?? null}
              height={source?.height ?? null}
              expectPortrait={firstPortrait}
            />
          </span>
        </span>

        {/* 入场转场：属于本卡，与缩略图同处一个 container */}
        <span className="flex shrink-0 items-center gap-1.5">
          {idx === 0 ? (
            <span className="px-1 text-[10px] text-text-disabled">
              {t('console.compilation.firstClipNoTransition')}
            </span>
          ) : (
            <>
              <span className="text-[10px] text-text-disabled">
                {t('console.compilation.incomingTransition')}
              </span>
              <Select
                aria-label={t('console.compilation.incomingTransition')}
                value={gap?.transition ?? 'cut'}
                onChange={(e) => onGap(e.target.value as CompilationTransition)}
                options={TRANSITION_PRESETS.map((p) => ({
                  value: p.value,
                  label: t(`console.compilation.transition_${p.value}`),
                }))}
                className="w-24"
              />
              {(gap?.transition ?? 'cut') !== 'cut' && (
                <>
                  <Input
                    type="number"
                    // step 必须能落到 0.32：step=0.1 时 0.32 不是合法步进值，
                    // 浏览器会在失焦/点箭头时把它悄悄改成 0.3 或 0.4。
                    step={0.01}
                    min={MIN_TRANSITION_S}
                    max={MAX_TRANSITION_S}
                    value={gap?.seconds ?? DEFAULT_TRANSITION_S}
                    onChange={(e) => onGapSeconds(Number(e.target.value))}
                    aria-label={t('console.compilation.transitionSeconds')}
                    /**
                     * `w-14`（56px）放不下：Input 自身 `px-3` 左右各吃掉 12px，
                     * number input 的 spinner 再占约 16px，留给数字的只剩 16px，
                     * `0.32` 直接被截。加宽到 `w-20`，并把左内边距收紧——
                     * spinner 是内容的一部分，压它右边就行，压左边等于浪费。
                     */
                    className="w-20 [&_input]:pl-2 [&_input]:pr-5"
                  />
                  <span className="shrink-0 text-[10px] text-text-disabled">s</span>
                </>
              )}
            </>
          )}
        </span>

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          className="shrink-0 text-text-disabled hover:text-error"
          title={t('common.delete')}
        >
          <Icon name="close" size={12} />
        </button>
      </div>
    </li>
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
  const [poolFilter, setPoolFilter] = useState('')
  /**
   * 拖拽用 ref 而不是 state：dragover 会连续触发几十次，每次 setState 都要重渲染
   * 整个序列。而拖拽中只需要「现在拖着谁」这个读一次的值。
   */
  const dragId = useRef<string | null>(null)
  const [dropHint, setDropHint] = useState<{ id: string; after: boolean } | null>(null)

  const shortcuts = useCompilationShortcuts({
    clipIds: ws.clipIds,
    selected: ws.selected,
    enabled: true,
    onMove: ws.move,
    onRemove: ws.remove,
    onToggle: ws.toggle,
    onSelect: ws.setSelected,
    // 数字键作用于**选中项的入场转场**，与卡内控件完全同一口径
    onSetTransition: (idx, i) => ws.setGapFor(idx, TRANSITION_KEY_ORDER[i]),
    onUndo: ws.undo,
    onRedo: ws.redo,
    onCreate: handleCreate,
    onBack: onBack,
  })

  const pool = poolFilter.trim()
    ? ws.pool.filter((s) => s.title.toLowerCase().includes(poolFilter.trim().toLowerCase()))
    : ws.pool

  async function handleCreate() {
    // 按钮已禁用，这里是最后一道：键盘快捷键（⌘Enter）也会走到这里，
    // 两条入口必须给出同一个结论，否则快捷键就成了绕过校验的后门。
    if (!ws.canCreate) {
      if (ws.clipIds.length === 0) toast(t('console.compilation.noClips'), 'error')
      return
    }
    const ok = await ws.create()
    if (ok) {
      toast(t('console.compilation.created', { n: ws.clipIds.length }), 'success')
      onCreated()
    } else if (ws.error) {
      toast(ws.error, 'error')
    }
  }

  /** 首片的朝向——混排预警的基准，必须和后端 `_resolve_target` 同一口径。 */
  const firstPortrait = useMemo(() => {
    const first = ws.items[0]?.source
    return first?.width != null && first?.height != null ? first.width < first.height : null
  }, [ws.items])

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

      {/*
        v0.38：横幅此前**在说谎**——`hasDraft` 只表示「localStorage 里有草稿」，
        而草稿从未被恢复进序列，用户看到的是「已恢复」+ 空列表。

        现在真的会恢复（见 useCompilationWorkspace 的恢复逻辑），所以这里的措辞
        也必须跟着改：恢复完成后再喊「已恢复」是废话，而**剪掉了哪几条**才是
        用户此刻真正需要知道的事。
      */}
      {ws.prunedCount > 0 && (
        <div className="shrink-0 border-b border-border bg-warning/10 px-3 py-1 text-[11px] text-warning">
          {t('console.compilation.draftPruned', { n: ws.prunedCount })}
        </div>
      )}

      {/* 主体：左池 + 序列 */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <PoolPanel
          pool={pool}
          filter={poolFilter}
          onFilter={setPoolFilter}
          clipIds={ws.clipIds}
          loading={ws.isLoading}
          firstPortrait={firstPortrait}
          onToggle={ws.toggle}
          onSelectAll={() => ws.addAll(pool.map((s) => s.id))}
          onInvert={() => ws.invertAll(pool.map((s) => s.id))}
        />

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
            <span className="text-[10px] uppercase tracking-wide text-text-disabled">
              {t('console.compilation.sequence')}
            </span>
            <span className="text-[10px] text-text-disabled">{t('console.compilation.dragHint')}</span>
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

          <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3 py-2" data-testid="compilation-sequence">
            {ws.items.length === 0 && (
              <li className="rounded-md border border-dashed border-border px-3 py-8 text-center text-xs text-text-disabled">
                {t('console.compilation.pickFirst')}
              </li>
            )}
            {ws.items.map((item) => (
              <SequenceRow
                key={item.id}
                id={item.id}
                idx={item.idx}
                source={item.source}
                state={item.state}
                selected={ws.selected === item.id}
                gap={item.idx > 0 ? ws.gaps[gapKey(ws.clipIds, item.idx) as string] : undefined}
                firstPortrait={firstPortrait}
                dropHint={dropHint?.id === item.id ? dropHint.after : null}
                dragging={dragId.current === item.id}
                onSelect={() => ws.setSelected(item.id)}
                onRemove={() => ws.remove(item.id)}
                onGap={(transition) => ws.setGapFor(item.idx, transition)}
                onGapSeconds={(seconds) => ws.setGapSecondsFor(item.idx, seconds)}
                onDragStart={() => {
                  dragId.current = item.id
                }}
                onDragEnd={() => {
                  dragId.current = null
                  setDropHint(null)
                }}
                onDragOver={(after) => {
                  const dragging = dragId.current
                  if (!dragging || dragging === item.id) return
                  if (dropHint?.id === item.id && dropHint.after === after) return
                  setDropHint({ id: item.id, after })
                  ws.moveTo(dragging, item.id, after)
                }}
                onDragLeave={() => setDropHint(null)}
              />
            ))}
          </ul>

          {/* 底栏：预警 + 主操作 */}
          <div className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-2">
            {/* 有片段查不到时，把原因摆在按钮旁边而不是等提交后吃后端的 400 */}
            {ws.missingIds.length > 0 && (
              <span className="text-[11px] text-error">
                {t('console.compilation.blockMissingSource', { n: ws.missingIds.length })}
              </span>
            )}
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
              disabled={!ws.canCreate}
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
              {SHORTCUT_ROWS.map(([k, label]) => (
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
