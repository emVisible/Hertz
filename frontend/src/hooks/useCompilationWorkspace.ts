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

export const TRANSITION_PRESETS: Array<{ value: CompilationTransition; seconds: number }> = [
  { value: 'cut', seconds: 0 },
  { value: 'fade', seconds: 0.6 },
  { value: 'wipe', seconds: 0.5 },
  { value: 'dissolve', seconds: 0.6 },
  { value: 'zoomin', seconds: 0.7 },
]
const DEFAULT_TRANSITION_S = 0.6

/** 单条合集的软上限：只警告不阻断（用户要长片时该让他做）。 */
export const LONG_COMPILATION_S = 600

/** 一个间隙的转场：键是「左片段 id」。 */
export type GapMap = Record<string, { transition: CompilationTransition; seconds: number }>

/** 把「片段顺序 + 间隙转场」编成请求体。首段无入场转场（服务端也会强制 cut）。 */
export function buildClips(clipIds: string[], gaps: GapMap): CompilationClip[] {
  return clipIds.map((id, i) =>
    i === 0
      ? { item_id: id }
      : {
          item_id: id,
          transition: gaps[clipIds[i - 1]]?.transition ?? 'cut',
          transition_s: gaps[clipIds[i - 1]]?.seconds ?? DEFAULT_TRANSITION_S,
        },
  )
}

/** 总时长：各段相加再扣掉转场重叠。返回 null 表示有段时长未知（宁可不给数也不给假的）。 */
export function estimateDuration(sources: Map<string, CompilationSource>, clipIds: string[], gaps: GapMap) {
  let total = 0
  for (const id of clipIds) {
    const d = sources.get(id)?.duration_s
    if (d == null) return null
    total += d
  }
  // 间隙键是**左片段 id**（与 buildClips、UI 的 setGap 同一口径）——
  // 按右片段查会少算最后一个间隙，预估凭空偏长一个转场时长。
  clipIds.forEach((_, i) => {
    if (i === 0) return
    const gap = gaps[clipIds[i - 1]]
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
  const chosen = useMemo(
    () => clipIds.map((id) => sources.get(id)).filter((s): s is CompilationSource => !!s),
    [clipIds, sources],
  )

  const estimate = useMemo(
    () => estimateDuration(sources, clipIds, gaps),
    [sources, clipIds, gaps],
  )
  const mixed = useMemo(
    () => mixedOrientation(sources, clipIds),
    [sources, clipIds],
  )

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

  const reorderTo = useCallback((dragId: string, targetId: string) => {
    history.set((s) => {
      if (dragId === targetId) return s
      const next = s.clipIds.filter((x) => x !== dragId)
      const at = next.indexOf(targetId)
      next.splice(at < 0 ? next.length : at, 0, dragId)
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

  const setGap = useCallback((leftId: string, transition: CompilationTransition) => {
    history.set((s) => ({
      ...s,
      gaps: {
        ...s.gaps,
        [leftId]: {
          transition,
          seconds: s.gaps[leftId]?.seconds
            || TRANSITION_PRESETS.find((p) => p.value === transition)?.seconds
            || DEFAULT_TRANSITION_S,
        },
      },
    }))
  }, [history])

  const setGapSeconds = useCallback((leftId: string, seconds: number) => {
    history.set((s) => ({
      ...s,
      gaps: {
        ...s.gaps,
        [leftId]: { transition: s.gaps[leftId]?.transition ?? 'fade', seconds: seconds },
      },
    }))
  }, [history])

  /** 一键把所有间隙设成同一种转场（替代 N 次手动）。 */
  const applyTransitionToAll = useCallback((transition: CompilationTransition) => {
    const seconds = TRANSITION_PRESETS.find((p) => p.value === transition)?.seconds ?? DEFAULT_TRANSITION_S
    history.set((s) => {
      const gaps: GapMap = {}
      for (let i = 0; i < s.clipIds.length - 1; i += 1) gaps[s.clipIds[i]] = { transition, seconds }
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

  return {
    pool, isLoading, sources, chosen, clipIds, gaps, selected,
    title, setTitle, outro, setOutro, saving, error, setError,
    estimate, mixed, toggle, move, reorderTo, remove, setGap, setGapSeconds,
    applyTransitionToAll, setSelected, create, reset,
    undo: history.undo, redo: history.redo,
    canUndo: history.canUndo, canRedo: history.canRedo,
    hasDraft: draft.hasDraft, discardDraft: draft.discard,
  }
}
