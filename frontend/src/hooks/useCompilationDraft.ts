/** 合集编排草稿（v0.36）——存 localStorage，切走再回来接着排。
 *
 * ## 为什么草稿和撤销重做都存在
 *
 * 它们防的不是同一件事：
 *
 * - **草稿**防「意外丢失」——切 tab、刷新、关窗口。编排十几段要好几分钟，
 *   丢一次就够劝退。
 * - **撤销重做**防「改错了」——尤其是「全选 40 段才发现选错了一半」这种。
 *   有了撤销就不必先想清楚再动手。
 *
 * 只有草稿没有撤销：得先手动记下「我刚才那 40 段是什么」才能安全试错。
 * 只有撤销没有草稿：切个 tab 全部蒸发，撤销栈也一起没了。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { CompilationTransition } from '../api/pipeline'

const DRAFT_KEY = 'hz.pipeline.compilation.draft.v1'

export interface DraftState {
  title: string
  clipIds: string[]
  gaps: Record<string, { transition: CompilationTransition; seconds: number }>
  outro: boolean
}

/** 读草稿要能扛住脏数据：手改 localStorage、跨版本字段变化都不能白屏。 */
export function loadDraft(storage: Storage | undefined): DraftState | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(DRAFT_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const d = parsed as Partial<DraftState>
    return {
      title: typeof d.title === 'string' ? d.title : '',
      clipIds: Array.isArray(d.clipIds) ? d.clipIds.filter((x) => typeof x === 'string') : [],
      gaps: d.gaps && typeof d.gaps === 'object' ? (d.gaps as DraftState['gaps']) : {},
      outro: d.outro === true,
    }
  } catch {
    // 草稿读不出来 = 当作没有草稿，不能因此让编排不可用
    return null
  }
}

function saveDraft(state: DraftState, storage: Storage | undefined) {
  if (!storage) return
  try {
    // 空编排不该留痕，否则下次打开会看到一条莫名其妙的空草稿
    if (state.clipIds.length === 0 && !state.title.trim()) {
      storage.removeItem(DRAFT_KEY)
      return
    }
    storage.setItem(DRAFT_KEY, JSON.stringify(state))
  } catch {
    // 配额满 / 隐私模式：编排本身不该因此失败
  }
}

export function useCompilationDraft(current: DraftState) {
  const [draft, setDraft] = useState<DraftState | null>(() => loadDraft(readStorage()))
  const restored = useRef(false)

  // 首次挂载：只有真存过东西才提示，避免空草稿弹提示
  useEffect(() => {
    if (restored.current) return
    restored.current = true
    if (draft && draft.clipIds.length > 0) setDraft({ ...draft, ...current })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 变更即存。用 current 而不是 draft：调用方的状态就是真相，草稿只是它的时间旅行。
  useEffect(() => {
    saveDraft(current, readStorage())
  }, [current.title, current.clipIds, current.gaps, current.outro]) // eslint-disable-line react-hooks/exhaustive-deps

  const discard = useCallback(() => {
    const s = readStorage()
    try {
      s?.removeItem(DRAFT_KEY)
    } catch {
      /* 忽略 */
    }
    setDraft(null)
  }, [])

  const hasDraft = !!draft && draft.clipIds.length > 0

  return { hasDraft, draft, discard }
}

function readStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

/**
 * 撤销/重做历史。
 *
 * 用 past/present/future 三段而不是「历史数组 + 指针」：指针版本一旦
 * `splice` 写错就是静默数据损坏，而三段式没有指针可错。
 *
 * `depth` 有上限——编排长片时可能拖进来上百次操作，无上限的历史是内存泄漏。
 * 压到 50 步，足够把「上一步」退回来，又不至于让人察觉到在截断。
 */
const MAX_HISTORY = 50

export function useHistory<T>(initial: T, depth = MAX_HISTORY) {
  const [past, setPast] = useState<T[]>([])
  const [present, setPresent] = useState<T>(initial)
  const [future, setFuture] = useState<T[]>([])

  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      setPresent((prev) => {
        const value = typeof next === 'function' ? (next as (p: T) => T)(prev) : next
        // 相同就不记历史，否则「选中不同项」这类空操作也能刷爆撤销栈
        if (Object.is(value, prev)) return prev
        setPast((p) => [...p, prev].slice(-depth))
        setFuture([])
        return value
      })
    },
    [depth],
  )

  const undo = useCallback(() => {
    setPast((p) => {
      if (p.length === 0) return p
      const previous = p[p.length - 1]
      setPresent((cur) => {
        setFuture((f) => [cur, ...f].slice(0, depth))
        return previous
      })
      return p.slice(0, -1)
    })
  }, [depth])

  const redo = useCallback(() => {
    setFuture((f) => {
      if (f.length === 0) return f
      const next = f[0]
      setPresent((cur) => {
        setPast((p) => [...p, cur].slice(-depth))
        return next
      })
      return f.slice(1)
    })
  }, [depth])

  const reset = useCallback((next: T) => {
    setPast([])
    setPresent(next)
    setFuture([])
  }, [])

  return useMemo(
    () => ({ present, set, undo, redo, reset, canUndo: past.length > 0, canRedo: future.length > 0 }),
    [present, set, undo, redo, reset, past.length, future.length],
  )
}