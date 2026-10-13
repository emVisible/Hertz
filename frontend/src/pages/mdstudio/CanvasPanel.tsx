/** MD Studio 中栏画布：平台感知的渲染态 DOM 挂载（设计 §5 中栏，§1 铁律 3）。
 *
 * 预览与导出共用同一条渲染管线（parseToIR → applyTheme / xhsCards）：画布展示的
 * DOM 与导出重建的 DOM 由同一套代码、同一份输入产出。画布不经过 React 渲染
 * （mdcore 产物是原生 DOM，直接 appendChild，无需 dangerouslySetInnerHTML）。
 * 导出动作在 MdStudioPage 里按同参数离屏重建——画布节点带预览缩放/深色滤镜，
 * 不能直接进剪贴板或截图。
 */

import { useEffect, type RefObject } from 'react'
import { applyTheme, parseToIR, xhsCards, XHS_CARD, type ThemeOverrides } from '@hertz/mdcore'

import type { LayoutPlatform } from '../../api'

/** xhs 卡片展示缩放基值：1242×1656 导出坐标系 → ~310px 展示宽 */
const XHS_DISPLAY_SCALE = 0.25

export interface XhsRenderInfo {
  pageCount: number
  overflow: boolean
}

interface CanvasPanelProps {
  sourceMd: string
  platform: LayoutPlatform
  themeId: string
  overrides: ThemeOverrides
  footer: string
  /** 0.5 / 0.75 / 1 */
  zoom: number
  dark: boolean
  /** 画布挂载点 */
  mountRef: RefObject<HTMLDivElement | null>
  onXhsInfo: (info: XhsRenderInfo) => void
}

export function CanvasPanel({
  sourceMd,
  platform,
  themeId,
  overrides,
  footer,
  zoom,
  dark,
  mountRef,
  onXhsInfo,
}: CanvasPanelProps) {
  useEffect(() => {
    const host = mountRef.current
    if (!host) return
    host.innerHTML = ''
    if (!sourceMd.trim()) {
      onXhsInfo({ pageCount: 0, overflow: false })
      return
    }
    try {
      const ir = parseToIR(sourceMd)
      // 深色预览（切片 D 简单正确方案）：微信有真深色主题「晚风」，预览时直接换主题，
      // 不改稿本身；xhs / zhihu 暂无深色主题，由外层容器深底 + 内容反色滤镜近似
      // （见 MdStudioPage 画布外框，切片 E 做逐主题深色款）。
      const previewTheme = dark && platform === 'wechat' ? 'wanfeng' : themeId
      if (platform === 'xhs') {
        const result = xhsCards(ir, { theme: previewTheme, overrides, footer })
        onXhsInfo({ pageCount: result.pageCount, overflow: result.overflow })
        const scale = XHS_DISPLAY_SCALE * zoom
        const band = document.createElement('div')
        band.style.display = 'flex'
        band.style.gap = '12px'
        band.style.alignItems = 'flex-start'
        for (const page of result.pages) {
          // 缩放槽 > 缩放层 > 卡片：transform 落在中间层，卡片节点本身保持
          // 1242px 原始坐标系（与导出产物同规格）
          const slot = document.createElement('div')
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
        }
        host.appendChild(band)
      } else {
        const el = applyTheme(ir, previewTheme, overrides)
        // 平台画布宽：微信=手机图文逻辑宽 375px；知乎=文章页 ~690px
        el.style.width = platform === 'wechat' ? '375px' : '690px'
        el.style.boxSizing = 'border-box'
        // CSS zoom：Electron=Chromium 原生支持，且缩放占布局（transform 会留白）。
        // 仅预览缩放——导出在 MdStudioPage 按原参数离屏重建，不读这份 DOM。
        el.style.setProperty('zoom', String(zoom))
        host.appendChild(el)
      }
    } catch {
      // markdown 编辑中间态解析失败：静默留空画布，不打断输入
      onXhsInfo({ pageCount: 0, overflow: false })
    }
    // overrides 对象随 draft 变更重建，引用即变更信号
  }, [sourceMd, platform, themeId, overrides, footer, zoom, dark, mountRef, onXhsInfo])

  // 宿主 div 不进 React children——渲染态 DOM 由上面 effect 全权管理
  return <div ref={mountRef} data-testid="mdstudio-canvas-mount" className="min-h-0" />
}
