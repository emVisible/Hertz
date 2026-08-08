import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Icon } from '../../components/ui'
import { useBoardStore } from '../../stores/board'

/**
 * 图层面板（Revel heritage）：新建 / 重命名（双击）/ 显隐 / 排序（order 大者在上）。
 * 新卡片落在激活层；隐藏层不渲染卡片但仍参与语义计算。
 */
export function LayerPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation()
  const board = useBoardStore((s) => s.board)
  const addLayer = useBoardStore((s) => s.addLayer)
  const renameLayer = useBoardStore((s) => s.renameLayer)
  const toggleLayer = useBoardStore((s) => s.toggleLayer)
  const moveLayer = useBoardStore((s) => s.moveLayer)
  const setActiveLayer = useBoardStore((s) => s.setActiveLayer)
  const [renaming, setRenaming] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (renaming) inputRef.current?.focus()
  }, [renaming])

  if (!open) return null

  const layers = [...board.layers].sort((a, b) => b.order - a.order)
  const countOf = (id: string) => board.cards.filter((c) => c.layerId === id).length

  function commitRename(id: string) {
    const el = inputRef.current
    if (el) renameLayer(id, el.value)
    setRenaming(null)
  }

  return (
    <aside className="flex w-52 shrink-0 flex-col border-r border-border bg-surface-1/80 backdrop-blur-sm">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          <Icon name="layers" size={15} />
          {t('canvas.layers.title')}
        </h2>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={addLayer}
            title={t('canvas.layers.new')}
            className=" p-1 text-text-secondary transition-colors hover:text-text-primary"
          >
            <Icon name="plus" size={14} />
          </button>
          <button
            type="button"
            onClick={onClose}
            className=" p-1 text-text-secondary transition-colors hover:text-text-primary"
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      </div>

      <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-1.5">
        {layers.map((layer) => {
          const active = layer.id === board.activeLayerId
          return (
            <li
              key={layer.id}
              onDoubleClick={() => setRenaming(layer.id)}
              className={`group flex items-center gap-1 px-1.5 py-1 text-xs transition-colors ${
                active ? 'bg-primary/10 text-text-primary' : 'text-text-secondary hover:bg-surface-2'
              }`}
            >
              <button
                type="button"
                onClick={() => toggleLayer(layer.id)}
                title={layer.visible ? t('canvas.layers.hide') : t('canvas.layers.show')}
                className={` p-0.5 ${layer.visible ? 'text-text-secondary' : 'text-text-disabled'}`}
              >
                <Icon name={layer.visible ? 'eye' : 'eye-off'} size={13} />
              </button>
              {renaming === layer.id ? (
                <input
                  ref={inputRef}
                  defaultValue={layer.name}
                  onBlur={() => commitRename(layer.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename(layer.id)
                    if (e.key === 'Escape') setRenaming(null)
                  }}
                  className="min-w-0 flex-1 bg-transparent text-xs text-text-primary outline-none"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setActiveLayer(layer.id)}
                  className="min-w-0 flex-1 truncate text-left"
                >
                  {layer.name}
                  <span className="ml-1 text-text-disabled">{countOf(layer.id)}</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => moveLayer(layer.id, 1)}
                title={t('canvas.layers.up')}
                className=" p-0.5 text-text-disabled opacity-0 transition-colors group-hover:opacity-100 hover:text-text-primary"
              >
                <Icon name="chevron-up" size={12} />
              </button>
              <button
                type="button"
                onClick={() => moveLayer(layer.id, -1)}
                title={t('canvas.layers.down')}
                className=" p-0.5 text-text-disabled opacity-0 transition-colors group-hover:opacity-100 hover:text-text-primary"
              >
                <Icon name="chevron-down" size={12} />
              </button>
            </li>
          )
        })}
        {layers.length === 0 && <p className="px-2 py-2 text-xs text-text-disabled">{t('canvas.layers.empty')}</p>}
      </ul>
    </aside>
  )
}
