import { useEffect, useRef, useState } from 'react'

import type { Card } from '../../canvas/types'
import { useBoardStore } from '../../stores/board'
import { Icon } from '../../components/ui'

export function CardView({
  card,
  selected,
  focused,
  clustersVisible,
  clusterColor,
  editing,
  pan,
  onEditDone,
  onSelect,
}: {
  card: Card
  selected: boolean
  focused: boolean
  clustersVisible: boolean
  clusterColor: string | undefined
  editing: boolean
  /** 画布平移（世界坐标 → 屏幕）：拖拽换算时减去 */
  pan: { x: number; y: number }
  onEditDone: () => void
  onSelect: () => void
}) {
  const moveCard = useBoardStore((s) => s.moveCard)
  const setContent = useBoardStore((s) => s.setContent)
  const setCardImage = useBoardStore((s) => s.setCardImage)
  const togglePin = useBoardStore((s) => s.togglePin)
  const deleteCard = useBoardStore((s) => s.deleteCard)
  const pinned = useBoardStore((s) => s.pinned.includes(card.id))
  const connecting = useBoardStore((s) => s.tool === 'line')
  const drag = useRef<{ dx: number; dy: number; moved: boolean } | null>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)

  // 内部编辑态：draft（新卡片，与卡片同批数据）或外部 editing（单击/双击）驱动
  const [internalEditing, setInternalEditing] = useState(card.draft === true)
  const isEditing = editing || internalEditing

  useEffect(() => {
    if (editing) setInternalEditing(true)
  }, [editing])

  // 进入编辑态即聚焦（draft 卡片首帧即编辑，effect 在挂载后立即聚焦）
  useEffect(() => {
    if (isEditing) {
      taRef.current?.focus()
      taRef.current?.select()
      const t = setTimeout(() => taRef.current?.focus(), 0)
      return () => clearTimeout(t)
    }
  }, [isEditing])

  function finishEditing() {
    // 清 draft 标记（内容写入或保持空，避免下次挂载再次进入编辑态）
    if (card.draft) setContent(card.id, card.content)
    setInternalEditing(false)
    onEditDone()
  }

  /** 输入态粘贴剪贴板图片 → 本卡转换为图片卡（Revel 同款交互）。 */
  function onPaste(e: React.ClipboardEvent) {
    const file = Array.from(e.clipboardData.files).find((f) => f.type.startsWith('image/'))
    if (!file) return
    e.preventDefault()
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = String(reader.result ?? '')
      const img = new Image()
      img.onload = () => {
        const maxW = 320
        const maxH = 240
        const scale = Math.min(maxW / img.width, maxH / img.height, 1)
        setCardImage(card.id, dataUrl, Math.round(img.width * scale), Math.round(img.height * scale))
      }
      img.src = dataUrl
      finishEditing()
    }
    reader.readAsDataURL(file)
  }

  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return
    // 编辑态下不拦截指针：让 textarea 正常聚焦/定位光标
    if (editing) return
    e.preventDefault()
    onSelect()
    drag.current = { dx: e.clientX - card.x - pan.x, dy: e.clientY - card.y - pan.y, moved: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!drag.current) return
    // 超过阈值才视为拖拽（否则松开 = 单击编辑）
    const dx = e.clientX - card.x - drag.current.dx
    const dy = e.clientY - card.y - drag.current.dy
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.current.moved = true
    if (drag.current.moved) moveCard(card.id, e.clientX - pan.x - drag.current.dx, e.clientY - pan.y - drag.current.dy)
  }

  function onPointerUp() {
    if (!drag.current) return
    const wasClick = !drag.current.moved
    drag.current = null
    // 单击（write 工具下）= 立即进入编辑（图片卡跳过）
    if (wasClick && useBoardStore.getState().tool === 'write' && card.type !== 'image') {
      useBoardStore.getState().setEditing(card.id)
    }
  }

  return (
    <div
      data-card-id={card.id}
      data-layer={card.layerId}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPaste={onPaste}
      style={{
        left: card.x,
        top: card.y,
        width: card.width,
        minHeight: card.height,
        borderColor: connecting ? '#f0abfc' : selected ? '#e879f9' : card.color,
        opacity: focused ? 0.38 : 1,
        transform: selected ? 'scale(1.04)' : undefined,
        boxShadow: pinned
          ? '0 0 0 2px rgba(244,114,182,.7), 0 6px 18px rgba(0,0,0,.35)'
          : selected
            ? '0 0 0 2px rgba(232,121,249,.55), 0 6px 18px rgba(0,0,0,.35)'
            : '0 4px 14px rgba(0,0,0,.28)',
      }}
      className={`group absolute z-10 cursor-grab touch-none  border-2 border-dashed bg-surface-1/95 p-2.5 backdrop-blur-sm transition-opacity duration-150 active:cursor-grabbing ${
        connecting ? 'ring-2 ring-fuchsia-400/40' : ''
      }`}
    >
      {clustersVisible && clusterColor !== undefined && (
        <span
          className="absolute -top-1.5 left-2 h-1 w-8 "
          style={{ background: clusterColor, boxShadow: `0 0 8px ${clusterColor}` }}
        />
      )}
      <div className="pointer-events-none mb-1 flex items-center justify-between">
        <span className="h-1.5 w-6 " style={{ background: card.color }} />
        <div
          className={`pointer-events-auto flex gap-1 transition-opacity ${
            selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          }`}
        >
          <button
            type="button"
            onClick={() => togglePin(card.id)}
            title="Pin"
            className={` p-0.5 ${pinned ? 'text-pink-400' : 'text-text-secondary hover:text-text-primary'}`}
          >
            <Icon name="pin" size={13} />
          </button>
          <button
            type="button"
            onClick={() => deleteCard(card.id)}
            title="Delete"
            className=" p-0.5 text-text-secondary hover:text-error"
          >
            <Icon name="trash" size={13} />
          </button>
        </div>
      </div>

      {card.type === 'image' && card.imageData ? (
        <div className="pointer-events-none">
          <img
            src={card.imageData}
            alt=""
            draggable={false}
            className="max-w-full select-none object-contain"
            style={{ maxHeight: card.height }}
          />
          {card.content && (
            <p className="font-kai mt-1 whitespace-pre-wrap text-xs leading-snug text-text-primary">
              {card.content}
            </p>
          )}
        </div>
      ) : isEditing ? (
        <textarea
          ref={taRef}
          value={card.content}
          onChange={(e) => setContent(card.id, e.target.value)}
          onBlur={finishEditing}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              // 回车提交并结束编辑（Shift+Enter 换行）
              e.preventDefault()
              finishEditing()
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              finishEditing()
            }
          }}
          className="w-full resize-none bg-transparent font-kai text-sm leading-snug text-text-primary outline-none"
          rows={Math.max(3, Math.ceil((card.content || ' ').length / 22))}
        />
      ) : (
        <p
          onDoubleClick={finishEditing}
          className="font-kai whitespace-pre-wrap text-sm leading-snug text-text-primary"
        >
          {card.content}
        </p>
      )}
    </div>
  )
}
