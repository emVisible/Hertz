/** 合集编排快捷键（v0.36）。
 *
 * ## 键位取舍
 *
 * 只给真正高频、且无法靠点两下完成的动作。别为了「显得完整」把低频操作也塞进
 * 键盘——快捷键的记忆成本是真的，用户记住十个记不住的键位，等于没有。
 *
 * | 键 | 动作 |
 * |---|---|
 * | ↑ ↓ / J K | 移动选中项 |
 * | Shift + ↑ ↓ | 把选中项挪一位 |
 * | 1…5 | 切当前间隙转场（cut/fade/wipe/dissolve/zoomin） |
 * | Space | 选中项加入 / 移出序列 |
 * | Delete / Backspace | 移除选中项 |
 * | ⌘/Ctrl + Z | 撤销 |
 * | ⌘/Ctrl + ⇧ + Z（或 Ctrl + Y）| 重做 |
 * | ⌘/Ctrl + Enter | 创建 |
 * | Esc | 返回预处理 |
 * | ? | 显示快捷键说明 |
 *
 * ## 最容易出错的地方：输入框里不能触发
 *
 * 标题框里按 Delete 是删字、按 Space 是打空格。若那时还去改序列，用户「打不出
 * 标题」——所以必须检查 `event.target`。这是 `isEditableTarget` 存在的唯一理由，
 * 也是它唯一需要测的理由。
 */
import { useEffect, useRef, useState } from 'react'

/** 输入框 / 下拉 / textarea / contenteditable 里，键盘属于用户不属于应用。 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName.toLowerCase()
  // isContentEditable 显式比 true：它是个可能为 undefined 的布尔（jsdom 没实现），
  // 直接返回会让这个 :boolean 函数吐出 undefined —— if 判断看不出问题，
  // 但有人写 === false 时就静默失效了。
  return (
    tag === 'input'
    || tag === 'textarea'
    || tag === 'select'
    || target.isContentEditable === true
  )
}

export interface ShortcutContext {
  clipIds: string[]
  selected: string | null
  onMove: (id: string, delta: number) => void
  onRemove: (id: string) => void
  onToggle: (id: string) => void
  onSelect: (id: string | null) => void
  /** 设置第 idx 段的入场转场（传 transition 的枚举下标）。用序号而不是 id，
   *  与 setGapFor 同一口径——UI 里再出现第二种写键方式就又有了错位的机会。 */
  onSetTransition: (idx: number, index: number) => void
  onUndo: () => void
  onRedo: () => void
  onCreate: () => void
  onBack: () => void
  enabled: boolean
}

/** 转场按数字键的顺序——必须与界面上的显示顺序一致，否则数字键指向看不见的位置。 */
export const TRANSITION_KEY_ORDER = ['cut', 'fade', 'wipe', 'dissolve', 'zoomin'] as const

export function useCompilationShortcuts(ctx: ShortcutContext) {
  const [helpOpen, setHelpOpen] = useState(false)
  // ctx 每次渲染都是新对象；存进 ref 才能让监听器只装一次，
  // 否则每渲染一次就 remove+add，等于每帧都在解绑重绑。
  const ref = useRef(ctx)
  ref.current = ctx

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const c = ref.current
      if (!c.enabled) return

      const mod = e.metaKey || e.ctrlKey

      // 撤销/重做：即使焦点在输入框里也要响应，否则打了一半标题按 ⌘Z
      // 期望撤销输入却什么都不发生——浏览器默认行为还会跟着一起撤销，双重混乱。
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) c.onRedo()
        else c.onUndo()
        return
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        c.onRedo()
        return
      }
      if (mod && e.key === 'Enter') {
        e.preventDefault()
        c.onCreate()
        return
      }

      // 其余键一律让给输入框：打标题时按 Delete 应该删字而不是删片段
      if (isEditableTarget(e.target)) return

      if (e.key === 'Escape') {
        e.preventDefault()
        c.onBack()
        return
      }
      if (e.key === '?') {
        e.preventDefault()
        setHelpOpen((v) => !v)
        return
      }
      if (e.key === ' ' && c.selected) {
        e.preventDefault()
        c.onToggle(c.selected)
        return
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && c.selected) {
        e.preventDefault()
        c.onRemove(c.selected)
        return
      }

      // 数字键：改**选中项的入场转场**。第 1 段没有入场转场，所以按数字无效。
      if (/^[1-5]$/.test(e.key) && c.selected) {
        const idx = c.clipIds.indexOf(c.selected)
        if (idx > 0) {
          e.preventDefault()
          c.onSetTransition(idx, Number(e.key) - 1)
        }
        return
      }

      const down = e.key === 'ArrowDown' || e.key === 'j'
      const up = e.key === 'ArrowUp' || e.key === 'k'
      if (!up && !down) return
      e.preventDefault()
      if (!c.clipIds.length) return

      // 无选中时用第一项起步，否则用户得先点一下才知道键盘能用
      const cur = c.selected ? c.clipIds.indexOf(c.selected) : -1
      const next = e.shiftKey
        ? // Shift 是「把这一项挪一位」——方向取反：按 ↓ 想让它往下走
          c.selected
          ? c.clipIds[cur + (down ? 1 : -1)]
          : undefined
        : c.clipIds[Math.min(c.clipIds.length - 1, Math.max(0, cur + (down ? 1 : -1)))]
      if (!next) return
      if (e.shiftKey) c.onMove(c.selected!, down ? 1 : -1)
      else c.onSelect(next)
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return { helpOpen, setHelpOpen }
}