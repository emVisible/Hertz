import { useTranslation } from 'react-i18next'

import { CHALK_COLORS } from '../../canvas/types'
import { useBoardStore } from '../../stores/board'
import { Icon } from '../../components/ui'

const TOOLS = [
  { id: 'write', icon: 'edit' },
  { id: 'pen', icon: 'pen' },
  { id: 'erase', icon: 'eraser' },
  { id: 'rect', icon: 'square' },
  { id: 'ellipse', icon: 'circle' },
  { id: 'line', icon: 'link' },
] as const

export function ToolDock() {
  const { t } = useTranslation()
  const tool = useBoardStore((s) => s.tool)
  const setTool = useBoardStore((s) => s.setTool)
  const strokeColor = useBoardStore((s) => s.strokeColor)
  const setStrokeColor = useBoardStore((s) => s.setStrokeColor)

  return (
    <div className="flex shrink-0 flex-col items-center gap-1 border-r border-border bg-surface-1/80 px-1.5 py-3">
      {TOOLS.map((toolDef) => (
        <button
          key={toolDef.id}
          type="button"
          title={t(`canvas.tool.${toolDef.id}`)}
          onClick={() => setTool(toolDef.id)}
          className={`rounded-md p-2 transition-[background-color,color,box-shadow] ${
            tool === toolDef.id
              ? 'bg-primary/20 text-primary shadow-sm'
              : 'text-text-secondary hover:bg-surface-2'
          }`}
        >
          <Icon name={toolDef.icon} size={18} />
        </button>
      ))}

      <div className="my-1 h-px w-8 bg-border" />

      {/* 粉笔色（Revel 1/2/3） */}
      <div className="flex flex-col items-center gap-1.5 py-0.5">
        {CHALK_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            title={color}
            onClick={() => {
              setStrokeColor(color)
              setTool('pen')
            }}
            className="h-4 w-4 rounded-full border border-black/20 shadow-sm transition-transform hover:scale-110"
            style={{
              background: color,
              boxShadow: strokeColor === color ? `0 0 0 2px rgba(255,255,255,.35)` : undefined,
            }}
          />
        ))}
      </div>

      <div className="my-1 h-px w-8 bg-border" />

      {/* 新卡片按钮已移除：点击画布任意处即可创建（轻量化） */}
    </div>
  )
}
