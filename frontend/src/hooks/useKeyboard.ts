import { useEffect } from 'react'

import { CHALK_COLORS } from '../canvas/types'
import { useBoardStore } from '../stores/board'

/**
 * 画布快捷键（Revel heritage，AXIOM §7.2 键盘优先）：
 * P 粉笔 / E 板擦 / U 矩形 / O 椭圆 / L 连线 / R 随机重排 /
 * 1·2·3 粉笔色 / Backspace·Delete 删选中卡 / 方向键微调 / ⌘E 导出 / ⌘G 聚类 / Esc 取消。
 */
export function useKeyboard() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey
      const s = useBoardStore.getState()
      if (meta && e.key.toLowerCase() === 'g') {
        e.preventDefault()
        s.toggleClusters()
        return
      }
      if (meta) return
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return
      switch (e.key) {
        case 'p':
        case 'P':
          s.setTool('pen')
          break
        case 'e':
        case 'E':
          s.setTool('erase')
          break
        case 'u':
        case 'U':
          s.setTool('rect')
          break
        case 'o':
        case 'O':
          s.setTool('ellipse')
          break
        case 'l':
        case 'L':
          s.setTool('line')
          break
        case 'r':
        case 'R':
          s.shuffleCards()
          break
        case '1':
        case '2':
        case '3':
          s.setStrokeColor(CHALK_COLORS[Number(e.key) - 1])
          s.setTool('pen')
          break
        case 'Backspace':
        case 'Delete':
          if (s.selectedId) s.deleteCard(s.selectedId)
          break
        case 'Escape':
          s.selectCard(null)
          s.setTool('write')
          break
        case 'ArrowLeft':
        case 'ArrowRight':
        case 'ArrowUp':
        case 'ArrowDown': {
          if (!s.selectedId) return
          e.preventDefault()
          const card = s.board.cards.find((c) => c.id === s.selectedId)
          if (!card) return
          const step = e.shiftKey ? 10 : 1
          const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
          const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0
          s.moveCard(card.id, card.x + dx, card.y + dy)
          break
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
