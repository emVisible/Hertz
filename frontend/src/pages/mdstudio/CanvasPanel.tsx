/** MD Studio 中栏画布：平台感知的渲染态 DOM 挂载（设计 §5 中栏，§1 铁律 3）。
 *
 * 预览与导出共用同一条渲染管线（parseToIR → applyTheme / xhsCards）：画布展示的
 * DOM 与导出重建的 DOM 由同一套代码、同一份输入产出。画布不经过 React 渲染
 * （mdcore 产物是原生 DOM，直接 appendChild，无需 dangerouslySetInnerHTML）。
 * 导出动作在 MdStudioPage 里按同参数离屏重建——画布节点带预览缩放/深色滤镜，
 * 不能直接进剪贴板或截图。
 *
 * 画布内联编辑（§10 候选 2）也挂在这里，且仍然不动 mdcore 的产物结构：
 *  - 点段落：渲染态顶层块带 `data-mdcore-block/-line`（applyTheme 打的定位标记），
 *    事件委托把「点到了哪一块 / 它的源码行号」交给宿主改 source_md；
 *  - 拖分页边界：小红书卡片底部一条可拖的边界线，落到哪块下沿就写一个强制断点
 *    （`breaks`，随稿存在 cover JSON 里），分页器只增不减，绝不裁内容。
 * 这两条都不改 DOM 语义，导出走离屏重建，所以交互层不会污染产物。
 */

import { useEffect, type RefObject } from 'react'
import {
  applyTheme,
  darkThemeFor,
  parseToIR,
  xhsCards,
  XHS_CARD,
  type ThemeOverrides,
} from '@hertz/mdcore'

import type { LayoutPlatform } from '../../api'

/** xhs 卡片展示缩放基值：1242×1656 导出坐标系 → ~310px 展示宽 */
const XHS_DISPLAY_SCALE = 0.25

/** 画布交互的样式层（悬停描边 / 边界手柄），只活在预览 DOM 里，不进任何导出产物 */
const CANVAS_CSS = `
[data-mdcore-block] { cursor: pointer; border-radius: 3px; }
[data-mdcore-block]:hover { outline: 1px dashed rgba(124, 58, 237, 0.55); outline-offset: 3px; }
[data-mdcore-boundary] { position: absolute; height: 0; border-top: 1px dashed rgba(124, 58, 237, 0.45); }
[data-mdcore-boundary]::after {
  content: ''; position: absolute; left: 50%; top: -5px; width: 26px; height: 10px;
  transform: translateX(-50%); border-radius: 5px;
  background: rgba(124, 58, 237, 0.55); cursor: ns-resize;
}
[data-mdcore-boundary]:hover, [data-mdcore-boundary][data-dragging='true'] { border-top-color: rgba(124, 58, 237, 0.95); }
/* 编辑器光标所在块：淡底 + 左侧色条。虚线是 hover，虚实分别是"可点"与"你现在在这儿" */
[data-mdcore-block][data-mdcore-focus='true'] {
  background: rgba(124, 58, 237, 0.07);
  box-shadow: inset 2px 0 0 rgba(124, 58, 237, 0.5);
}
[data-mdcore-block][data-mdcore-focus='true']:hover { outline: none; }
`

export interface XhsRenderInfo {
  pageCount: number
  overflow: boolean
}

/** 点到的块：IR 序号 + 源码行号区间（markdown-it token.map，0 起） */
export interface CanvasBlockTarget {
  index: number
  line: [number, number] | null
}

interface CanvasPanelProps {
  sourceMd: string
  platform: LayoutPlatform
  themeId: string
  overrides: ThemeOverrides
  footer: string
  qr: string | null
  /** 手动拖过的分页边界（IR 块序号），随稿入库 */
  breaks: number[]
  /** 0.5 / 0.75 / 1 */
  zoom: number
  dark: boolean
  /** 空稿提示（i18n 由宿主传入） */
  emptyHint: string
  /** 画布挂载点 */
  mountRef: RefObject<HTMLDivElement | null>
  onXhsInfo: (info: XhsRenderInfo) => void
  onBlockClick?: (target: CanvasBlockTarget) => void
  /** 编辑器光标所在块：画布上高亮并滚到视线里（编辑器 → 画布方向） */
  focusBlockIndex?: number | null
  onBreaksChange?: (breaks: number[]) => void
}

function parseLine(raw: string | null): [number, number] | null {
  if (!raw) return null
  const m = /^(\d+)-(\d+)$/.exec(raw)
  return m ? [Number(m[1]), Number(m[2])] : null
}

/** 从点击目标回溯到最近的顶层块（拆页后的续块也带同一个 data-mdcore-block） */
function blockTargetOf(node: EventTarget | null): CanvasBlockTarget | null {
  const el = node instanceof Element ? node.closest('[data-mdcore-block]') : null
  const index = el?.getAttribute('data-mdcore-block') ?? null
  if (!el || index === null || !/^\d+$/.test(index)) return null
  return { index: Number(index), line: parseLine(el.getAttribute('data-mdcore-line')) }
}

/** 一页里各块的「块序号 + 块底边 y（卡片坐标系）」，按视觉顺序 */
interface Boundary {
  index: number
  bottom: number
}

function boundariesOf(page: HTMLElement): Boundary[] {
  const body = page.querySelector('.mdcore-page-body')
  if (!body) return []
  const out: Boundary[] = []
  for (const child of Array.from(body.children) as HTMLElement[]) {
    const raw = child.getAttribute('data-mdcore-block')
    if (raw === null || !/^\d+$/.test(raw)) continue
    out.push({ index: Number(raw), bottom: child.offsetTop + child.offsetHeight })
  }
  return out
}

/**
 * 分页边界手柄：拖到哪块下沿，就把「这一页到此为止」写成强制断点。
 * 落到本页最后一块下沿 = 取消这条边界（回到自然分页）；往上拖只会让本页变少。
 */
function attachBoundary(
  slot: HTMLElement,
  page: HTMLElement,
  pages: HTMLElement[],
  pageIndex: number,
  scale: number,
  breaks: number[],
  onChange: (next: number[]) => void,
): void {
  const here = boundariesOf(page)
  const next = boundariesOf(pages[pageIndex + 1])
  if (!here.length || !next.length) return
  const currentBoundary = next[0].index
  const last = here[here.length - 1]

  const handle = document.createElement('div')
  handle.setAttribute('data-mdcore-boundary', String(pageIndex))
  handle.style.left = '8px'
  handle.style.right = '8px'
  handle.style.pointerEvents = 'auto'
  handle.style.setProperty('z-index', '2')
  const place = (y: number) => {
    handle.style.top = `${y * scale}px`
  }
  place(last.bottom)
  slot.appendChild(handle)

  let picked = last.index
  const onDown = (e: Event) => {
    const ev = e as PointerEvent
    ev.preventDefault()
    ev.stopPropagation()
    // 指针捕获：拖出卡片范围松手也要收到 pointerup，否则边界会卡在"按下"状态
    if (typeof slot.setPointerCapture === 'function' && typeof ev.pointerId === 'number') {
      try {
        slot.setPointerCapture(ev.pointerId)
      } catch {
        /* jsdom / 无捕获支持：监听器仍挂在 slot 上，退化成只在卡片内生效 */
      }
    }
    handle.setAttribute('data-dragging', 'true')
    const move = (me: PointerEvent) => {
      const rect = slot.getBoundingClientRect()
      const y = (me.clientY - rect.top) / (scale || 1)
      // 吸到最近的块下沿
      picked = here.reduce((best, b) =>
        Math.abs(b.bottom - y) < Math.abs(best.bottom - y) ? b : best,
      ).index
      place(Math.min(y, last.bottom))
    }
    const up = () => {
      handle.removeAttribute('data-dragging')
      slot.removeEventListener('pointermove', move)
      slot.removeEventListener('pointerup', up)
      slot.removeEventListener('pointercancel', up)
      // 落回本页最后一块下沿 = 不动（自然分页）；否则换一条强制边界
      const boundary = picked + 1
      const rest = breaks.filter((b) => b !== currentBoundary)
      if (boundary !== currentBoundary) rest.push(boundary)
      onChange([...new Set(rest)].sort((a, b) => a - b))
    }
    slot.addEventListener('pointermove', move)
    slot.addEventListener('pointerup', up)
    slot.addEventListener('pointercancel', up)
  }
  handle.addEventListener('pointerdown', onDown)
}

export function CanvasPanel({
  sourceMd,
  platform,
  themeId,
  overrides,
  footer,
  qr,
  breaks,
  zoom,
  dark,
  emptyHint,
  mountRef,
  onXhsInfo,
  onBlockClick,
  onBreaksChange,
  focusBlockIndex,
}: CanvasPanelProps) {
  useEffect(() => {
    const host = mountRef.current
    if (!host) return
    host.innerHTML = ''
    if (!sourceMd.trim()) {
      // 空稿也要有反馈：留一行提示，避免中栏看起来像坏了
      const hint = document.createElement('div')
      hint.textContent = emptyHint
      hint.style.setProperty('color', 'var(--hz-text-disabled)')
      hint.style.setProperty('font-size', '13px')
      hint.style.setProperty('padding', '48px 12px')
      hint.style.setProperty('text-align', 'center')
      host.appendChild(hint)
      onXhsInfo({ pageCount: 0, overflow: false })
      return
    }
    const style = document.createElement('style')
    style.textContent = CANVAS_CSS
    host.appendChild(style)
    /** 点段落：委托到容器上，块结构由 mdcore 决定，React 不参与渲染态 */
    const onClick = onBlockClick
      ? (e: Event) => {
          const target = blockTargetOf(e.target)
          if (target) onBlockClick(target)
        }
      : null
    try {
      const ir = parseToIR(sourceMd)
      // 深色预览：优先切到该平台的真深色主题（晚风/夜航/墨案），只影响预览不改稿；
      // 平台无深色款时保持原主题，由外层容器深底近似（见 MdStudioPage 画布外框）。
      const darkPreset = dark ? darkThemeFor(platform) : undefined
      const previewTheme = darkPreset?.id ?? themeId
      if (platform === 'xhs') {
        const result = xhsCards(ir, { theme: previewTheme, overrides, footer, qr, breaks })
        onXhsInfo({ pageCount: result.pageCount, overflow: result.overflow })
        const scale = XHS_DISPLAY_SCALE * zoom
        const band = document.createElement('div')
        band.style.display = 'flex'
        band.style.gap = '12px'
        band.style.alignItems = 'flex-start'
        result.pages.forEach((page, index) => {
          // 缩放槽 > 缩放层 > 卡片：transform 落在中间层，卡片节点本身保持
          // 1242px 原始坐标系（与导出产物同规格）
          const slot = document.createElement('div')
          slot.style.position = 'relative'
          slot.style.width = `${XHS_CARD.width * scale}px`
          slot.style.height = `${XHS_CARD.height * scale}px`
          slot.style.flex = 'none'
          slot.style.borderRadius = '8px'
          slot.style.overflow = 'hidden'
          slot.style.boxShadow = '0 1px 3px rgba(0,0,0,0.12)'
          slot.style.transition = 'transform 150ms, box-shadow 150ms'
          slot.addEventListener('mouseenter', () => {
            slot.style.transform = 'translateY(-2px)'
            slot.style.boxShadow = '0 6px 16px rgba(0,0,0,0.16)'
          })
          slot.addEventListener('mouseleave', () => {
            slot.style.transform = ''
            slot.style.boxShadow = '0 1px 3px rgba(0,0,0,0.12)'
          })
          const scaler = document.createElement('div')
          scaler.style.transform = `scale(${scale})`
          scaler.style.transformOrigin = 'top left'
          scaler.appendChild(page)
          slot.appendChild(scaler)
          band.appendChild(slot)
          if (onBreaksChange && index < result.pages.length - 1) {
            attachBoundary(slot, page, result.pages, index, scale, breaks, onBreaksChange)
          }
        })
        if (onClick) band.addEventListener('click', onClick)
        host.appendChild(band)
      } else {
        const el = applyTheme(ir, previewTheme, overrides)
        // 平台画布宽：微信=手机图文逻辑宽 375px；知乎=文章页 ~690px
        el.style.width = platform === 'wechat' ? '375px' : '690px'
        el.style.boxSizing = 'border-box'
        // CSS zoom：Electron=Chromium 原生支持，且缩放占布局（transform 会留白）。
        // 仅预览缩放——导出在 MdStudioPage 按原参数离屏重建，不读这份 DOM。
        el.style.setProperty('zoom', String(zoom))
        if (onClick) el.addEventListener('click', onClick)
        host.appendChild(el)
      }
    } catch {
      // markdown 编辑中间态解析失败：静默留空画布，不打断输入
      onXhsInfo({ pageCount: 0, overflow: false })
    }
    // overrides 对象随 draft 变更重建，引用即变更信号
  }, [
    sourceMd,
    platform,
    themeId,
    overrides,
    footer,
    qr,
    breaks,
    zoom,
    dark,
    emptyHint,
    mountRef,
    onXhsInfo,
    onBlockClick,
    onBreaksChange,
  ])

  /**
   * 编辑器 → 画布：光标所在块高亮并滚进视线。
   *
   * 独立成一个 effect，而不是塞进上面那个渲染 effect 的分支里：光标每动一行就
   * 触发一次，重新渲染整篇画布（重新分页、重新量高）会让联动变成灾难性的开销。
   * 这里只翻一个 DOM 属性 + 一次 scrollIntoView，代价与稿子长度无关。
   *
   * 放在渲染 effect **之后**声明：同一次 commit 里 React 按声明顺序跑，
   * 于是"重渲染 + 重新标记"不会互相踩。
   */
  useEffect(() => {
    const host = mountRef.current
    if (!host) return
    for (const el of Array.from(host.querySelectorAll('[data-mdcore-focus]'))) {
      el.removeAttribute('data-mdcore-focus')
    }
    if (focusBlockIndex === null || focusBlockIndex === undefined) return
    const el = host.querySelector(`[data-mdcore-block="${focusBlockIndex}"]`)
    if (el instanceof HTMLElement) {
      el.setAttribute('data-mdcore-focus', 'true')
      // jsdom 没实现 scrollIntoView；没有它就不滚（高亮照样生效），别让联动整条断掉
      if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' })
    }
  }, [focusBlockIndex, mountRef])

  // 宿主 div 不进 React children——渲染态 DOM 由上面 effect 全权管理
  return <div ref={mountRef} data-testid="mdstudio-canvas-mount" className="min-h-0" />
}