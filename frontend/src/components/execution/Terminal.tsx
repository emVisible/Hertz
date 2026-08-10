import { useEffect, useRef, type ReactNode } from 'react'

import { Card, Icon } from '../ui'

export interface LogLine {
  id: number
  time: string
  text: string
  kind: string
}

export interface TerminalProps {
  title: string
  lines: LogLine[]
  /** kind → 行级类名（域自定义着色） */
  kindClass: (kind: string) => string
  streaming?: boolean
  onClear?: () => void
  /** 底部附加区域（如运行记录）：渲染在日志区下方，融入终端卡片 */
  bottom?: ReactNode
}

/**
 * 实时日志终端（Studio/Pipeline 共用）：
 * 深底 + 时间戳 + 行 hover + 内部滚动（v0.3.0：固定视口高度 max-h，
 * 不再随内容无限向下）+ 智能自动滚底（用户上滚时暂停，滚回底部恢复）。
 */
export function Terminal({ title, lines, kindClass, streaming, onClear, bottom }: TerminalProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickBottom = useRef(true)

  // 滚动位置判定：接近底部 → 保持自动滚底；用户上滚 → 暂停
  function onScroll() {
    const el = scrollRef.current
    if (!el) return
    stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
  }

  useEffect(() => {
    const el = scrollRef.current
    if (el && stickBottom.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [lines])

  return (
    <Card padded={false} className="flex min-h-0 flex-1 flex-col lg:col-span-2">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        <div className="flex items-center gap-2">
          {onClear && (
            <button
              type="button"
              onClick={onClear}
              className="border border-border px-1.5 py-0.5 text-[10px] text-text-secondary transition-colors hover:border-text-disabled"
            >
              清空
            </button>
          )}
          {streaming && (
            <span className="flex items-center gap-1 text-[10px] text-primary">
              <Icon name="console" size={10} className="animate-pulse" />
            </span>
          )}
          <span className="font-mono text-[10px] text-text-disabled">{lines.length} lines</span>
        </div>
      </div>
      {/* 固定视口高度 + 内部滚动：内容再多也不把页面撑无限长（v0.3.0） */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="h-72 min-h-0 overflow-y-auto bg-surface-2/50 p-2 font-mono text-[11px] leading-relaxed"
      >
        {lines.length === 0 ? (
          <p className="p-2 text-text-disabled">—</p>
        ) : (
          lines.map((log) => (
            <div key={log.id} className={`flex gap-2 px-1.5 py-0.5 hover:bg-surface-2 ${kindClass(log.kind)}`}>
              <span className="shrink-0 select-none text-text-disabled">{log.time}</span>
              <span className="min-w-0 break-all">{log.text}</span>
            </div>
          ))
        )}
      </div>
      {bottom && <div className="shrink-0 border-t border-border">{bottom}</div>}
    </Card>
  )
}
