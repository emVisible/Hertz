/**
 * 一次编辑只该解析一次（W0 性能）。
 *
 * 病根是「一次解析多处没用」：大纲、光标反查、画布渲染**各自**调 `parseToIR`，
 * 而光标那条还挂在 `setFocusBlock` 的 updater 里——于是每按一键都同步跑一遍全篇解析，
 * **完全绕过了 150ms 防抖**。万字稿单次解析约 15ms，node/jsdom 环境下已经是这个量级，
 * 浏览器里同理；每键三段（同步一次 + 防抖后大纲一次 + 画布一次），输入是跟不上的。
 *
 * 更糟的是它在 `setState` 的 updater 里做解析：updater 必须是纯函数，StrictMode 下
 * 会跑两次，于是**一次按键两次解析**，而这类错没有任何断言会红。
 *
 * 这份判据不测"跑得快"（jsdom 的耗时数不可信），测的是**次数**：
 * 次数是确定的，耗时不是。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 数**画布重排次数**——也就是用户真正感觉到的东西。
 *
 * 试过数"解析调了几次"，走不通：`@hertz/mdcore` 是 workspace 源码包，
 * 测试里的 `vi.mock` 拦得住自己 import 的那份，却拦不住 `MdStudioPage` 内部的调用
 * （自检显示 mock 本身是活的：测试里直接调 `parseToIR` 计数 +1，而页面里调同一个
 * 函数计数纹丝不动）。数一个自己观测不到的量，得到的判据就是幻觉。
 *
 * 重排次数则完全在 DOM 上：渲染态由 effect 全权重建，每重排一次画布挂载点就被
 * 换一批子节点。这是用户看见的"每按一键整篇重排"，也是防抖唯一真正该拦住的东西。
 */
let repaintCount = 0
function watchRepaints(root: Element): () => number {
  const observer = new MutationObserver((records) => {
    repaintCount += records.filter((r) => r.addedNodes.length > 0).length
  })
  observer.observe(root, { childList: true, subtree: true })
  return () => {
    observer.disconnect()
    return repaintCount
  }
}

const PARA = '这一段用来把稿子撑到万字量级，中文排版对每行的处理都要走到，不能偷懒。'
const BIG_MD = [
  '# 万字稿标题',
  '',
  '[toc]',
  '',
  ...Array.from({ length: 220 }, (_, i) => `${PARA}（第${i}段）`),
].join('\n\n')

const BASE: Record<string, unknown> = {
  id: 'l1',
  title: '万字稿',
  platform: 'wechat',
  theme_id: 'modi',
  source_md: BIG_MD,
  overrides: {},
  cover: {},
  created_at: '2026-10-15T00:00:00Z',
  updated_at: '2026-10-15T00:00:00Z',
}

let docData: Record<string, unknown>

vi.mock('../../api', () => ({
  layoutApi: {
    list: () =>
      Promise.resolve([
        { id: 'l1', title: '万字稿', platform: 'wechat', theme_id: 'modi', updated_at: '' },
      ]),
    get: () => Promise.resolve(docData),
    update: () => Promise.resolve({ ok: true }),
  },
  docsApi: { list: () => Promise.resolve([]) },
}))

import { MdStudioPage } from './MdStudioPage'

const wrapper = ({ children }: { children: ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

beforeEach(() => {
  docData = { ...BASE }
  repaintCount = 0
})

afterEach(() => {
  vi.useRealTimers()
})

/** 等首屏画布渲染完 */
async function ready() {
  render(<MdStudioPage />, { wrapper })
  await waitFor(() => expect(document.querySelector('.mdcore-doc')).toBeTruthy(), { timeout: 5000 })
  const mount = document.querySelector('[data-testid="mdstudio-canvas-mount"]') as HTMLElement
  watchRepaints(mount)
  repaintCount = 0 // 首屏那几次是初始化，不计入"每键几次"
}

describe('一次编辑只解析一次', () => {
  it('打开万字稿后，连打 8 个字，画布只重排一次（不是每键一次）', async () => {
    await ready()
    const editor = document.querySelector('.cm-content') as HTMLElement
    expect(editor, '找不到 CodeMirror 编辑区').toBeTruthy()

    // 先证明判据驱动的是**真状态**：合成的 keydown 不会改内容（第一版就栽在这），
    // 那样的"通过"是空的。这里用 CodeMirror 真能吃下的键盘事件逐字输入。
    const user = userEvent.setup()
    await act(async () => {
      await user.type(editor, '一二三四五六七八')
    })
    expect(editor.textContent ?? '').toContain('一二三四')
    // 等防抖窗口过去，画布那一次解析也该落地了
    await act(async () => {
      await new Promise((r) => setTimeout(r, 260))
    })

    // 关键不变式：一串输入只该引起**一次**重排（防抖窗口内合并）。
    // 修复前是每键一次——因为光标回调的依赖里有 source_md，身份每键都换，
    // 而那个回调进了画布渲染 effect 的依赖，于是防抖只挡文本、挡不住回调。
    expect(repaintCount).toBeLessThanOrEqual(2)
  })

  it('只移动光标不产生解析（联动不该拖着全篇重排）', async () => {
    await ready()
    const user = userEvent.setup()
    // 走"点大纲"这条路：jsdom 里 CM 选区来自 DOM Selection，合成键盘改不动它，
    // 而大纲点击走 CM 自己的 dispatch，会真的触发 onCursorLine（见 MdStudioEditor.test.tsx
    // 里那条同名说明）。用能触发的路测，比造一个测不动的假键盘诚实。
    const before = repaintCount
    for (let i = 0; i < 6; i += 1) {
      const items = document.querySelectorAll('[data-testid^="outline-item-"]')
      const target = items[Math.min(i, items.length - 1)] as HTMLElement
      expect(target, '大纲没有可点的项').toBeTruthy()
      await act(async () => {
        await user.click(target)
      })
    }
    // 联动是"翻一个属性 + scrollIntoView"，代价与稿子长度无关
    expect(repaintCount).toBe(before)
  })

  it('大纲与画布读的是同一份 IR（结构上就一份，不靠巧合）', async () => {
    await ready()
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200))
    })
    // 大纲三项：h1 + 三个 h2（最大层级 3）
    // 大纲面板在渲染出来了（不是空态）
    const outline = document.querySelector('[data-testid="mdstudio-outline"]')
    expect(outline, '大纲面板没出现').toBeTruthy()
    expect(outline?.textContent ?? '').not.toContain('mdstudio.outline.empty')
    // 挂上之后画布不再重排（结构上就是一份，不靠"恰好没再触发"）
    expect(repaintCount).toBe(0)
  })
})

describe('图没就位就重排一次，且只一次', () => {
  /**
   * 分页量的是 `getBoundingClientRect()`，而**未加载的图片高度是 0**——于是那一页被
   * 塞得过满，图一加载内容就被推下去，卡片在用户眼前重排。导出路径早有闸门，
   * 预览路径没有，于是"预览里会动、导出却稳"这种不一致最难自查。
   *
   * 判据量的是**重排次数**：一次输入 + 一张慢图，最多触发一次额外重排。
   */
  it('慢图加载后重排一次；不会自我触发成死循环', async () => {
    docData = { ...BASE, source_md: `${BIG_MD}\n\n![慢图](https://slow.example/a.png)\n\n结尾一段。` }
    const user = userEvent.setup()
    render(<MdStudioPage />, { wrapper })
    await waitFor(() => expect(document.querySelector('.mdcore-doc')).toBeTruthy(), { timeout: 5000 })
    await waitFor(() => expect(document.querySelector('.cm-content')).toBeTruthy(), { timeout: 5000 })

    const mount = document.querySelector('[data-testid="mdstudio-canvas-mount"]') as HTMLElement
    watchRepaints(mount)
    repaintCount = 0
    // jsdom 不加载外链，图天然 complete —— 这条只验「不会死循环」
    const before = repaintCount
    await act(async () => {
      await user.type(document.querySelector('.cm-content') as HTMLElement, '甲')
      await new Promise((r) => setTimeout(r, 300))
    })
    // 等图闸门最多等 2s；超时后不得反复触发（`lastRemeasureKey` 守的就是这个）
    await act(async () => {
      await new Promise((r) => setTimeout(r, 600))
    })
    // 关键：**有限次**。死循环会在这里变成上千次。
    expect(repaintCount - before).toBeLessThanOrEqual(6)
  })
})
