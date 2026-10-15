/**
 * 小红书卡片在画布里必须**整张装得下**——判据。
 *
 * 起因是一句人话：「上下布局需要再优化一下 padding 把 container 核心部分挤出去了」。
 * 查下来是真的：卡片展示高度是写死的比例（`XHS_FIT_SCALE * zoom`），**完全不看窗口有多高**，
 * 而它上下还叠了两层留白（滚动区 p-4 + 卡片框 p-3 = 每边 28px）。于是
 *
 *   3:4  1440 × 0.39 = 562px  + 100px（工具条+留白） = 662px + 缩略图条
 *   9:16 1920 × 0.39 = 749px  + 100px                  = 849px + 缩略图条
 *
 * 窗口矮一点，3:4 已经被挤出去一半；9:16 必然被切掉一截。用户看到的现象就是
 * 「卡片下面那一截不见了，要拖着滚动条才看得到页脚」——而页脚与缩略图条恰恰是
 * 判断"这一页还有没有内容"的依据。
 *
 * 两条判据：
 * ①**装得下**：给定窗口高度，卡片 + 缩略图条不超过可用高度（不能靠滚动才看全）。
 * ②**不白缩**：窗口够高时仍是那个比例，不因为自动适配而无故变小。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import '../../i18n'

const BASE: Record<string, unknown> = {
  id: 'l1',
  title: '卡片稿',
  platform: 'xhs',
  theme_id: 'taoyao',
  source_md: '# 封面标题\n\n正文一段，用来把卡片填出内容。\n\n## 第一节\n\n再一段。',
  overrides: {},
  cover: { footer: '图文工坊' },
  created_at: '2026-10-15T00:00:00Z',
  updated_at: '2026-10-15T00:00:00Z',
}

vi.mock('../../api', () => ({
  layoutApi: {
    list: () =>
      Promise.resolve([
        { id: 'l1', title: '卡片稿', platform: 'xhs', theme_id: 'taoyao', updated_at: '' },
      ]),
    get: () => Promise.resolve(docData),
  },
  docsApi: { list: () => Promise.resolve([]) },
}))

import { MdStudioPage } from './MdStudioPage'

/** 每条用例切回 3:4：上一条改过 ratio 会漏到下一条 */
let docData: Record<string, unknown>

const wrapper = ({ children }: { children: ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

/** jsdom 量不出真实布局（handover §4 第 9 条），所以自己造一个高度 */
/** 每条用例都从干净稿子开始：上一条改过 cover 槽会漏到下一条 */
beforeEach(() => {
  docData = { ...BASE, cover: { footer: '图文工坊' } }
})

/**
 * 给**画布滚动区**造一个视口高度。
 *
 * 关键：造高度的必须是滚动区（`data-mdstudio-canvas-viewport`），不是画布挂载点。
 * 第一版判据给挂载点造高度，于是「正反馈一路缩到下限」这个 bug 全绿——因为挂载 div
 * 的高度**就是卡片自己的高度**，真实浏览器里拿它当可用高度只会越来越矮。
 * 判据造的数必须与浏览器里真实存在的那个元素对上，否则验的是幻觉。
 */
function stubViewportHeight(px: number): void {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute('data-mdstudio-canvas-viewport') ? px : 400
    },
  })
}

function slotSize(): { height: number; width: number } {
  const slot = document.querySelector('[data-xhs-page]') as HTMLElement
  return { height: parseFloat(slot.style.height), width: parseFloat(slot.style.width) }
}

describe('卡片整张装得下（不靠滚动才看全）', () => {
  it('窗口矮（520px）时自动缩到装得下，且标记出「已缩放」', async () => {
    stubViewportHeight(520)
    render(<MdStudioPage />, { wrapper })
    await waitFor(() => expect(document.querySelector('[data-xhs-page]')).toBeTruthy(), { timeout: 3000 })
    const { height } = slotSize()
    // 卡片高 + 缩略图条预留必须落进 520px 里
    expect(height).toBeLessThanOrEqual(520 - 64)
    // 降级要看得见：不能悄悄把字缩到看不清还不告诉用户
    expect(document.querySelector('[data-xhs-page]')?.getAttribute('data-xhs-fitted')).toBe('true')
  })

  it('窗口够高（1600px）时不缩——比例就是设定值，不被自动适配无故改小', async () => {
    stubViewportHeight(1600)
    render(<MdStudioPage />, { wrapper })
    await waitFor(() => expect(document.querySelector('[data-xhs-page]')).toBeTruthy(), { timeout: 3000 })
    const { height, width } = slotSize()
    // 3:4 在 1080 坐标系下，宽高比必须是 3:4（这是"卡片没被压扁"的底线）
    expect(height / width).toBeCloseTo(1440 / 1080, 1)
    expect(document.querySelector('[data-xhs-page]')?.getAttribute('data-xhs-fitted')).toBeNull()
    // 名义比例：0.39 展示基值 × 1080 = 421px 宽（留有富余，没被缩）
    expect(width).toBeGreaterThan(400)
  })

  it('9:16 这种高比例在矮窗口里同样装得下（最容易被切的那种）', async () => {
    stubViewportHeight(500)
    // 比例存在 cover JSON 槽里（ratioOf(doc.cover)），不是顶层字段
    docData.cover = { footer: '图文工坊', ratio: '9:16' }
    render(<MdStudioPage />, { wrapper })
    await waitFor(() => expect(document.querySelector('[data-xhs-page]')).toBeTruthy(), { timeout: 3000 })
    const { height, width } = slotSize()
    expect(height).toBeLessThanOrEqual(500 - 64)
    expect(height / width).toBeCloseTo(1920 / 1080, 1)
  })
})

describe('缩到不可读时停下来并说清楚', () => {
  it('极矮窗口（300px）触到下限：不再继续缩，且仍标记「装不下」', async () => {
    stubViewportHeight(300)
    render(<MdStudioPage />, { wrapper })
    await waitFor(() => expect(document.querySelector('[data-xhs-page]')).toBeTruthy(), { timeout: 3000 })
    const { height, width } = slotSize()
    // 下限 0.2：再缩正文就只剩 7px，那不是排版是邮票——所以允许溢出滚动
    expect(width).toBeCloseTo(1080 * 0.2, 0)
    expect(height).toBeCloseTo(1440 * 0.2, 0)
    // 但"装不下"必须看得见
    expect(document.querySelector('[data-xhs-page]')?.getAttribute('data-xhs-fitted')).toBe('true')
  })
})

describe('不越缩越小（正反馈）', () => {
  /**
   * 这条是为一个真 bug 写的：自动适配当时量的是**画布挂载点**的高度，
   * 而挂载 div 没有高度约束——它的高度**就是卡片自己的高度**。于是
   * 「拿上一张卡片的高度去约束这一张」，每次重渲染都更矮，一路缩到下限。
   *
   * jsdom 完全看不出来（不排版、clientHeight 恒 0），而第一版判据还给挂载点造了个
   * 高度，正好造出一个真实浏览器里永不存在的数——判据绿灯，线上卡片一路缩小。
   *
   * 现在判据两处都咬：①高度造在**滚动区**上（浏览器里真实存在的那个元素）；
   * ②这条断言同一视口下两次重渲染尺寸**稳定**。
   */
  it('缩放档位改来改去，同一档位尺寸不变（不漂移）', async () => {
    stubViewportHeight(520)
    render(<MdStudioPage />, { wrapper })
    await waitFor(() => expect(document.querySelector('[data-xhs-page]')).toBeTruthy(), { timeout: 3000 })
    const zoom = screen.getByLabelText('缩放') as HTMLSelectElement
    const home = slotSize()

    await act(async () => {
      fireEvent.change(zoom, { target: { value: '0.75' } })
    })
    await waitFor(() => expect(slotSize().width).not.toBe(home.width))

    // 关键不变式：回到原档位，尺寸必须**回到原值**。
    // 反馈环一旦成立，每一轮重渲染都在拿"上一张卡片的高度"当输入，
    // 于是来回切几次尺寸会一路漂——这条会立刻抓住。
    await act(async () => {
      fireEvent.change(zoom, { target: { value: '1' } })
    })
    await waitFor(() => expect(slotSize().width).toBeCloseTo(home.width, 0))
    expect(slotSize().height).toBeCloseTo(home.height, 0)
  })
})

describe('画布上下不留白不叠加', () => {
  it('卡片上下留白收窄到每边 ≤16px（原先 p-4 + p-3 = 28px）', async () => {
    stubViewportHeight(900)
    render(<MdStudioPage />, { wrapper })
    await waitFor(() => expect(document.querySelector('[data-xhs-page]')).toBeTruthy(), { timeout: 3000 })
    const scroll = document.querySelector('[data-xhs-page]')!.closest('.overflow-auto') as HTMLElement
    const frame = scroll.firstElementChild as HTMLElement
    // 从 class 名里读回留白，不去猜 getComputedStyle（jsdom 不算 Tailwind 类）
    const pad = (el: HTMLElement) => {
      const m = /p-(\d)/.exec(el.className)
      return m ? Number(m[1]) * 4 : 0
    }
    expect(pad(scroll) + pad(frame)).toBeLessThanOrEqual(16)
  })
})
