import { useCallback, useState } from 'react'

import type { PipelineItem } from '../api'

/** 批量选择模式（wave10.1）：审核/归档清理/备用库共用。
 *  进入模式 → 点击列表项切换选中；全选 = 当前列表全部；
 *  退出模式清空选中；执行批量后清空但留在模式内（可连续批量）。 */
export function useBatchSelect(items: PipelineItem[]) {
  const [mode, setMode] = useState(false)
  const [sel, setSel] = useState<Set<string>>(new Set())

  const toggle = useCallback((item: PipelineItem) => {
    setSel((prev) => {
      const next = new Set(prev)
      if (next.has(item.id)) next.delete(item.id)
      else next.add(item.id)
      return next
    })
  }, [])

  const toggleAll = useCallback(() => {
    setSel((prev) =>
      prev.size === items.length ? new Set() : new Set(items.map((i) => i.id)),
    )
  }, [items])

  const clear = useCallback(() => setSel(new Set()), [])

  const enter = useCallback(() => setMode(true), [])
  const exit = useCallback(() => {
    setMode(false)
    setSel(new Set())
  }, [])

  return {
    mode,
    enter,
    exit,
    clear,
    sel,
    toggle,
    toggleAll,
    selected: items.filter((i) => sel.has(i.id)),
  }
}