/** 合集编排状态机（v0.35）——`useCompilationWorkspace`。
 *
 * 界面只管画，所有状态与派生数据（时长预估、转场扣减、混排预警、创建请求体）
 * 都在这里。理由：编排是**高频且有逻辑**的操作（排序、转场、时长累加），
 * 埋在 JSX 里既测不动、也读不清。
 *
 * ## 时长预估怎么算
 *
 * 不是「各段相加」——转场会让两段画面**重叠**（xfade），总时长因此**变短**：
 *
 *     total = Σdur[i] − Σtransition_s[i]   （i 为每个非硬切间隙）
 *
 * 少了后面那项，预估会**偏长**，且段数越多偏得越多。
 *
 * ## 混排预警为什么必须要有
 *
 * `assemble._resolve_target` 按**首片朝向**决定输出画幅（竖屏优先，理由见
 * 该函数注释）。于是把竖屏与横屏混在一起时，后者会被 pad 出黑边。这是
 * P1 定下的行为，不是 bug——但用户按下「创建」之前完全看不到它，而那意味
 * 着返工重排。预警就是把这个「事后才发现」提前到现在。
 */
import { useCallback, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import type {
  CompilationClip,
  CompilationSource,
  CompilationTransition,
  CreateCompilationBody,
} from '../api/pipeline'
import { pipelineApi } from '../api/pipeline'
import { useCompilationDraft, useHistory } from './useCompilationDraft'

/** 与后端 `assemble.TRANSITIONS` 同名同默认——界面发英文档名，后端才认。 */
import type { DraftState } from './useCompilationDraft'

/**
 * 转场时长默认值与合法范围（v0.37）。
 *
 * ## 为什么所有预设共用同一个 0.32s
 *
 * 原本 fade=0.6 / wipe=0.5 / dissolve=0.6 / zoomin=0.7 各不相同。这个「讲究」
 * 在编排面板上是负资产：用户切一次转场就换一次时长，**总时长跟着变**，
 * 而他并没有要求这件事——于是「预估 3:12」在他换了两次转场后变成「3:09」，
 * 他只会认为是面板算错了。统一默认值后，切转场不再动总时长。
 *
 * 需要调时长的用户可以自己拖那个输入框——那是有意识的行为，不该是默认。
 *
 * ## 范围与后端同源
 *
 * MIN/MAX 对应后端 `assemble.MIN_TRANSITION_S` / `MAX_TRANSITION_S`。
 * 界面**不该**允许输入后端会钳制掉的数：填 0.1 会被后端抬回 0.2，
 * 界面给的反馈与实际生效的不一致。
 */
export const MIN_TRANSITION_S = 0.2
export const MAX_TRANSITION_S = 3
export const DEFAULT_TRANSITION_S = 0.32

/** 与后端 `assemble.TRANSITIONS` 同名——界面发英文档名，后端才认。 */
export const TRANSITION_PRESETS: Array<{ value: CompilationTransition; seconds: number }> = [
  { value: 'cut', seconds: 0 },
  { value: 'fade', seconds: DEFAULT_TRANSITION_S },
  { value: 'wipe', seconds: DEFAULT_TRANSITION_S },
  { value: 'dissolve', seconds: DEFAULT_TRANSITION_S },
  { value: 'zoomin', seconds: DEFAULT_TRANSITION_S },
]

/** 单条合集的软上限：只警告不阻断（用户要长片时该让他做）。 */
export const LONG_COMPILATION_S = 600

/** 一个间隙的转场。键由 `gapKey` 决定——全代码库只此一个定义。 */
export type GapMap = Record<string, { transition: CompilationTransition; seconds: number }>

/**
 * 第 `idx` 段的**入场转场**（播放它之前的那一下）存在哪个键下。
 *
 * ## 为什么必须是这个函数，而不是各处自己写 `clipIds[idx-1]`
 *
 * v0.37 出过一个真实的错位 bug：转场下拉框的 `value` 读 `gaps[clipIds[idx-1]]`
 * （这张卡**之前**的间隙），`onChange` 却写 `gaps[s.id]`（这张卡**之后**的间隙）。
 * 同一个控件读写两个键，于是「改第 1、2 段之间的转场」实际改到了第 2、3 段。
 *
 * 根因不是打错一个字，是**两套约定并存**：卡片读「之前」、写「之后」。只要 UI
 * 还允许直接按 id 写 gap，这种错位随时会重新长出来。所以：
 *
 * - 读、写、时长预估、快捷键**全部**走这一个函数；
 * - `setGapFor` 只接受「第几段」而不是 id，从 API 上就不给写错的机会。
 *
 * 首段没有入场转场 → null。
 */
export function gapKey(clipIds: readonly string[], idx: number): string | null {
  if (idx <= 0 || idx >= clipIds.length) return null
  return clipIds[idx - 1] ?? null
}

/** 把「片段顺序 + 间隙转场」编成请求体。首段无入场转场（服务端也会强制 cut）。 */
export function buildClips(clipIds: string[], gaps: GapMap): CompilationClip[] {
  return clipIds.map((id, i) => {
    const key = gapKey(clipIds, i)
    if (key === null) return { item_id: id }
    return {
      item_id: id,
      transition: gaps[key]?.transition ?? 'cut',
      transition_s: gaps[key]?.seconds ?? DEFAULT_TRANSITION_S,
    }
  })
}

/** 总时长：各段相加再扣掉转场重叠。返回 null 表示有段时长未知（宁可不给数也不给假的）。 */
export function estimateDuration(sources: Map<string, CompilationSource>, clipIds: string[], gaps: GapMap) {
  let total = 0
  for (const id of clipIds) {
    const d = sources.get(id)?.duration_s
    if (d == null) return null
    total += d
  }
  clipIds.forEach((_, i) => {
    const key = gapKey(clipIds, i)
    if (key === null) return
    const gap = gaps[key]
    if (gap && gap.transition !== 'cut') total -= gap.seconds
  })
  return total
}

/** 画幅是否混排（首片朝向为基准，与后端 _resolve_target 同一口径）。 */
export function mixedOrientation(sources: Map<string, CompilationSource>, clipIds: string[]) {
  const known = clipIds
    .map((id) => sources.get(id))
    .filter((s): s is CompilationSource => !!s && s.width != null && s.height != null)
  if (known.length < 2) return false
  const firstPortrait = known[0].width! < known[0].height!
  return known.some((s) => (s.width! < s.height!) !== firstPortrait)
}

export function useCompilationWorkspace() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  // 编排数据全部走 history：title/clipIds/gaps/outro 是同一次排布的四个侧面，
  // 分开存会各自进栈，于是「撤销」只撤销其中一半（改标题把顺序也撤了）。
  const history = useHistory<DraftState>({ title: '', clipIds: [], gaps: {}, outro: false })
  const { title, clipIds, gaps, outro } = history.present
  const setTitle = (v: string) => history.set((s) => ({ ...s, title: v }))
  const setOutro = (v: boolean) => history.set((s) => ({ ...s, outro: v }))

  // 选中项不入历史：它不是排布的一部分，撤销它只会让人莫名其妙
  const [selected, setSelected] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const draft = useCompilationDraft({ title, clipIds, gaps, outro })

  const { data: pool = [], isLoading } = useQuery({
    queryKey: ['compilation-sources'],
    queryFn: pipelineApi.compilationSources,
  })

  const sources = useMemo(() => new Map(pool.map((s) => [s.id, s])), [pool])
  /**
   * 按 `clipIds` 顺序逐项解出，`source` 允许为 null。
   *
   * 之前这里是 `clipIds.map(...).filter(Boolean)`：某个片段的源条目不在候选里
   * （文件被清理、条目被归档）时它被滤掉，于是**`chosen` 的下标与 `clipIds` 错开**，
   * UI 里 `gaps[clipIds[idx-1]]` 拿到的就是另一个间隙。行号不再等于序号。
   * 缺失源要留在列表里占住自己的位置（UI 显示「源已移除」并允许删除），
   * 这样下标永远是下标。
   */
  const items = useMemo(
    () => clipIds.map((id, idx) => {
      const source = sources.get(id) ?? null
      return {
        id,
        idx,
        source,
        // **加载中不等于缺失**（v0.38）。
        //
        // 候选列表是异步查回来的，`pool` 在拿到响应前是空数组。此前 `source`
        // 为 null 就一律渲染「源已移除」——于是每次进面板的最初几百毫秒里，
        // 已经在序列里的片段会被**冤枉成文件丢了**。用户看到的是一个关于
        // 他自己数据的、彻头彻尾的假结论。
        //
        // 这里显式区分三种状态，让 UI 只在确实查过了之后才下结论。
        state: source ? 'ready' as const : isLoading ? 'loading' as const : 'missing' as const,
      }
    }),
    [clipIds, sources, isLoading],
  )

  /** 确实查过、且确实查不到的片段。加载中一律不算。 */
  const missingIds = useMemo(
    () => items.filter((it) => it.state === 'missing').map((it) => it.id),
    [items],
  )

  const estimate = useMemo(
    () => estimateDuration(sources, clipIds, gaps),
    [sources, clipIds, gaps],
  )
  const mixed = useMemo(
    () => mixedOrientation(sources, clipIds),
    [sources, clipIds],
  )

  /** 把给定的一批 id 全部加入（已在的不动）——「全选」作用于**当前筛选结果**，
   *  不是整个候选池：在搜「旅行」时点全选却把 300 条全加进来，是最容易被骂的 bug。 */
  const addAll = useCallback((ids: string[]) => {
    history.set((s) => {
      const have = new Set(s.clipIds)
      const add = ids.filter((id) => !have.has(id))
      if (add.length === 0) return s
      return { ...s, clipIds: [...s.clipIds, ...add] }
    })
  }, [history])

  /** 反选：只作用于给定范围（同样是「当前筛选结果」）。 */
  const invertAll = useCallback((ids: string[]) => {
    history.set((s) => {
      const scope = new Set(ids)
      const out = s.clipIds.filter((id) => !scope.has(id))
      const added = ids.filter((id) => !s.clipIds.includes(id))
      return { ...s, clipIds: [...out, ...added] }
    })
  }, [history])

  const toggle = useCallback((id: string) => {
    history.set((s) => ({
      ...s,
      clipIds: s.clipIds.includes(id) ? s.clipIds.filter((x) => x !== id) : [...s.clipIds, id],
    }))
  }, [history])

  const move = useCallback((id: string, delta: number) => {
    history.set((s) => {
      const i = s.clipIds.indexOf(id)
      const j = i + delta
      if (i < 0 || j < 0 || j >= s.clipIds.length) return s
      const clipIds = [...s.clipIds]
      ;[clipIds[i], clipIds[j]] = [clipIds[j], clipIds[i]]
      return { ...s, clipIds }
    })
  }, [history])

  /**
   * 把 `dragId` 移到 `targetId` 的前面（`after=false`）或后面（`after=true`）。
   *
   * 拖拽期间 dragover 会连着触发几十次，所以每次都必须得出**正确**的落点：
   * 去掉 dragId 之后在剩余序列里找 target 的下标，再按 `after` 偏移一位。
   * 少偏移一位或者用过滤前的下标，结果就是「插到目标前面却跑到了它后面」。
   */
  const moveTo = useCallback((dragId: string, targetId: string, after: boolean) => {
    history.set((s) => {
      if (dragId === targetId) return s
      const next = s.clipIds.filter((x) => x !== dragId)
      const at = next.indexOf(targetId)
      if (at < 0) return s
      next.splice(after ? at + 1 : at, 0, dragId)
      return { ...s, clipIds: next }
    })
  }, [history])

  const remove = useCallback((id: string) => {
    history.set((s) => {
      const gaps = { ...s.gaps }
      delete gaps[id]
      return { ...s, clipIds: s.clipIds.filter((x) => x !== id), gaps }
    })
  }, [history])

  /**
   * 设置「第 idx 段入场」的转场。
   *
   * 只接受序号、不接受 id：调用方拿不到「该写哪个键」的决定权，也就没有写错的可能。
   * 首段是 no-op（没有入场可言），而不是默默写到别的间隙上。
   */
  const setGapFor = useCallback(
    (idx: number, transition: CompilationTransition) => {
      history.set((s) => {
        const key = gapKey(s.clipIds, idx)
        if (key === null) return s
        return {
          ...s,
          gaps: {
            ...s.gaps,
            [key]: {
              transition,
              // 沿用用户上次为这个间隙调过的时长；换预设时才回落到预设值
              seconds: s.gaps[key]?.seconds
                || TRANSITION_PRESETS.find((p) => p.value === transition)?.seconds
                || DEFAULT_TRANSITION_S,
            },
          },
        }
      })
    },
    [history],
  )

  const setGapSecondsFor = useCallback((idx: number, seconds: number) => {
    history.set((s) => {
      const key = gapKey(s.clipIds, idx)
      if (key === null) return s
      return {
        ...s,
        gaps: {
          ...s.gaps,
          [key]: { transition: s.gaps[key]?.transition ?? 'fade', seconds },
        },
      }
    })
  }, [history])

  /** 一键把所有间隙设成同一种转场（替代 N 次手动）。 */
  const applyTransitionToAll = useCallback((transition: CompilationTransition) => {
    const seconds = TRANSITION_PRESETS.find((p) => p.value === transition)?.seconds ?? DEFAULT_TRANSITION_S
    history.set((s) => {
      const gaps: GapMap = {}
      // 第 0 段没有入场转场，所以从第 1 段开始
      for (let i = 1; i < s.clipIds.length; i += 1) {
        const key = gapKey(s.clipIds, i)
        if (key !== null) gaps[key] = { transition, seconds }
      }
      return { ...s, gaps }
    })
  }, [history])

  async function create(): Promise<boolean> {
    if (clipIds.length === 0) {
      setError(t('console.compilation.noClips'))
      return false
    }
    setSaving(true)
    setError('')
    try {
      const body: CreateCompilationBody = {
        title: title.trim() || null,
        clips: buildClips(clipIds, gaps),
        outro: outro ? { enabled: true, duration_s: 2.5 } : null,
      }
      await pipelineApi.createCompilation(body)
      await queryClient.invalidateQueries({ queryKey: ['pipeline-stage'] })
      await queryClient.invalidateQueries({ queryKey: ['pipeline-queue'] })
      await queryClient.invalidateQueries({ queryKey: ['compilation-sources'] })
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return false
    } finally {
      setSaving(false)
    }
  }

  function reset(initial?: string[]) {
    history.reset({ title: '', clipIds: initial ?? [], gaps: {}, outro: false })
    setSelected(null)
    setError('')
  }

  /**
   * 能不能创建。后端 `create_compilation` 本来就会拒绝缺条目/状态不对/无 raw
   * 的组合（前端只是不该让用户走到那一步才吃一个错误 toast）。
   *
   * `missingIds` 非空时禁用：让用户对着一个必然失败的提交按钮点下去，
   * 再从服务端拿回一句「片段不存在」，那是把校验责任推给了用户。
   */
  const canCreate = clipIds.length > 0 && missingIds.length === 0

  return {
    pool, isLoading, sources, items, clipIds, gaps, selected,
    missingIds, canCreate,
    title, setTitle, outro, setOutro, saving, error, setError,
    estimate, mixed, toggle, move, moveTo, remove, addAll, invertAll,
    setGapFor, setGapSecondsFor, applyTransitionToAll, setSelected, create, reset,
    undo: history.undo, redo: history.redo,
    canUndo: history.canUndo, canRedo: history.canRedo,
    hasDraft: draft.hasDraft, discardDraft: draft.discard,
  }
}
