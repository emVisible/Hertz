import { describe, expect, it } from 'vitest'
import { xhsCards, xhsCardSize, XHS_PADDING } from './xhs'
import { parseToIR } from '../ir/parseToIR'
import type { Measurer } from '../index'

/** 粗略高度模型：段落按字数算行，图片按宽度比例算，表格按行数算 */
function blockHeight(el: HTMLElement): number {
  const img = el.querySelector?.('img')
  if (img) {
    const w = parseFloat((el as HTMLElement).style.width || '1080')
    return Math.round(w * 0.5625)
  }
  if (el.tagName === 'TABLE') return 60 * (el.querySelectorAll('tr').length + 1)
  const text = el.textContent ?? ''
  return Math.max(1, Math.ceil(text.length / 22)) * 63
}

function measurerFor(avail: number): Measurer {
  return {
    fits(body) {
      let h = 0
      for (const c of Array.from(body.children)) h += blockHeight(c as HTMLElement)
      return h <= avail + 0.5
    },
  }
}

const LONG_TABLE = '| 项目 | 值 |\n| --- | --- |\n' + Array.from({ length: 10 }, (_, i) => `| 第${i}行 | ${i} |`).join('\n')

describe('probe 比例溢出', () => {
  it('长表格在各比例下是否被裁', () => {
    for (const ratio of ['3:4', '4:3', '1:1'] as const) {
      const card = xhsCardSize(ratio)
      const avail = card.height - XHS_PADDING - (XHS_PADDING + card.footerSpace)
      const r = xhsCards(parseToIR('# 标题\n\n' + LONG_TABLE), {
        theme: 'taoyao', doc: globalThis.document, ratio, measurer: measurerFor(avail),
      })
      // 每页表格块数：确认表格被拆了而不是整块塞进去
      const perPage = r.pages.map((p) => p.querySelectorAll('table').length)
      console.log(`${ratio} 可用=${avail} 页数=${r.pageCount} 每页表格=${perPage.join(',')}`)
    }
    expect(true).toBe(true)
  })

  it('一张大图在各比例下是否装得下', () => {
    for (const ratio of ['3:4', '4:3', '9:16'] as const) {
      const card = xhsCardSize(ratio)
      const avail = card.height - XHS_PADDING - (XHS_PADDING + card.footerSpace)
      const svg = "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='1080'%20height='608'%3E%3C/svg%3E"
      const r = xhsCards(parseToIR('# 标题\n\n![图](' + svg + '){100%}'), {
        theme: 'taoyao', doc: globalThis.document, ratio, measurer: measurerFor(avail),
      })
      const body = r.pages[1]?.querySelector('.mdcore-page-body') as HTMLElement
      const img = body?.querySelector('img') as HTMLElement
      console.log(`${ratio} 可用=${avail} 页数=${r.pageCount} 图宽=${img?.style.width} 图高=${img?.style.height} 溢出=${img ? parseFloat(img.style.height || '0') > avail : 'n/a'}`)
    }
    expect(true).toBe(true)
  })
})
