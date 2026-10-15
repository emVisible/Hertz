/**
 * 页码必须**钉在右下角**，不随内容长度飘。
 *
 * 起因是人话四连之一：「页码不固定，应该固定到右下角」。
 *
 * 页壳是 flex 列、正文 `flex: 1 1 auto`，所以页脚确实落在页面底部；但**页脚自己是
 * 一个普通块**，里面是 `[署名 span][页码 span]` 两个行内元素按文档流排：页码紧跟在
 * 署名后面，于是它在**左下角**，而且署名一长（或者带了二维码）就换行，页码跟着往下掉。
 * 「固定在右下角」这条要求，此前一点都没被满足。
 *
 * 判据不看像素，看**约束**：页脚是 flex 行、页码 `margin-left: auto` 顶到右端、
 * 与署名同基线（所以不会换行）。这三条在 jsdom 里都能验，而且换文案长度不会让它们变红。
 */
import { describe, expect, it } from 'vitest'

import { parseToIR } from '../ir/parseToIR'
import { xhsCards } from './xhs'

const MEASURER = { fits: () => true }

function card(footer: string, extra: Record<string, unknown> = {}) {
  const result = xhsCards(parseToIR('# 标题\n\n正文一段，用来撑出内容。\n\n## 第二节\n\n再一段。'), {
    theme: 'taoyao',
    doc: globalThis.document,
    measurer: MEASURER,
    footer,
    ...extra,
  })
  // pages[0] 是独立封面，封面刻意不带页码（xhs.ts 里 cover 的 chrome 把 pageNum 关掉），
  // 所以要取**第一张正文页**，否则测的是一个不存在的页码槽
  const body = result.pages.find((pg) => pg.querySelector('.mdcore-card-pageno'))
  return body as HTMLElement
}

function probe(page: HTMLElement) {
  const el = page.querySelector('.mdcore-card-footer') as HTMLElement
  const brand = el.querySelector('.mdcore-card-watermark') as HTMLElement
  const num = el.querySelector('.mdcore-card-pageno') as HTMLElement
  return { footer: el, brand, num }
}

describe('页码钉在右下角', () => {
  it('页脚是 flex 行（所以页码能被顶到右端，而不是跟在署名后面流动）', () => {
    const { footer } = probe(card('图文工坊'))
    expect(footer.style.display).toBe('flex')
    expect(footer.style.alignItems).toBe('baseline')
  })

  it('页码用 margin-left:auto 顶到右端（不靠"署名短"这种运气）', () => {
    const { num } = probe(card('图文工坊'))
    expect(num.style.marginLeft).toBe('auto')
  })

  it('署名再长也不把页码挤到第二行（页码位置与署名长度无关）', () => {
    // jsdom 量不出排版，所以验约束而不是像素：页码必须 flex:none（不被压缩换行）
    const { num: long, brand } = probe(card('一个特别特别长的品牌署名占满整行看看页码会不会掉下去'))
    expect(long.style.flexShrink).toBe('0')
    expect(long.style.whiteSpace).toBe('nowrap')
    // 署名自己截断，不去挤页码
    expect(brand.style.textOverflow).toBe('ellipsis')
    expect(long.style.whiteSpace).toBe('nowrap')
  })

  it('页脚落在页面底部（正文撑开、页脚在后）', () => {
    const page = card('图文工坊')
    const body = page.querySelector('.mdcore-page-body') as HTMLElement
    expect(body.style.flex).toBe('1 1 auto')
    const kids = [...page.children]
    expect(kids.indexOf(body)).toBeLessThan(kids.indexOf(probe(page).footer))
  })

  it('带二维码时页码仍与二维码同组贴右，不被甩到中间', () => {
    const page = card('图文工坊', { qr: 'data:image/png;base64,AAAA' })
    const { num, footer } = probe(page)
    expect(num.style.marginLeft).toBe('auto')
    expect(num.style.flexShrink).toBe('0')
    // 页码与二维码在同一个右端组里：靠 auto 左边距隔开，不会被 space-between 甩到中间
    const kids = [...footer.children]
    expect(kids[kids.length - 1].tagName).toBe('IMG')
    expect(kids[kids.length - 2]).toBe(num)
  })

  it('页码内容是「第 N / 共 M 页」的形式', () => {
    const { num } = probe(card('图文工坊'))
    expect(num.textContent).toMatch(/^\d+ \/ \d+$/)
  })
})
