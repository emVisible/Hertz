import { useEffect, useRef, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'

/**
 * 页面级过渡（AXIOM §6.1：零依赖 WAAPI）。
 *
 * 设计（单色企业感）：内容仅 200ms 淡入（无位移——位移叠加内容重排
 * 是抖动的根源）；顶部一道主色细线以 translateX 从窗口左端滑到右端
 * （300ms，ease-in-out），如快门扫过，随后自然淡出。transform 只作用
 * 于线本身，不触碰内容布局。
 */
export function PageTransition({ children }: { children: ReactNode }) {
  const location = useLocation()
  const shellRef = useRef<HTMLDivElement>(null)
  const lineRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const shell = shellRef.current
    const line = lineRef.current
    if (!shell || typeof shell.animate !== 'function') return
    shell.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'ease-out' })
    if (line && typeof line.animate === 'function') {
      line.animate(
        [
          { transform: 'translateX(-100%)', opacity: 1 },
          { transform: 'translateX(0%)', opacity: 1, offset: 0.75 },
          { transform: 'translateX(0%)', opacity: 0 },
        ],
        { duration: 300, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' },
      )
    }
  }, [location.pathname])

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={lineRef}
        className="pointer-events-none absolute left-0 top-0 z-20 h-px w-full bg-primary"
        style={{ transform: 'translateX(-100%)' }}
      />
      <div key={location.pathname} ref={shellRef} className="flex min-h-0 flex-1 flex-col">
        {children}
      </div>
    </div>
  )
}
