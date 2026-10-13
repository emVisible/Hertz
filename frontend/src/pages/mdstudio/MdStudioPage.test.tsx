/** MdStudioPage 的 smoke 测试（超级 Markdown 模块 切片 D 前端）。
 *
 * 钉三条动线：①无稿空态 → 新建；②有稿渲染三栏，画布真的挂上了 applyTheme
 * 产出的渲染态 DOM（jsdom 下 mdcore 可跑，与 mdcore 自身测试同环境）；
 * ③切平台 Tab → 稿的 platform + 该平台默认主题随自动保存 PUT 出去；
 * ④删除走 Modal 确认再发 remove。
 * 不在这层断言的：剪贴板 payload、截图导出（jsdom 给不了，mdcore 层已测）。
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string) => key,
    }),
  }
})

const calls: Record<string, unknown[][]> = {}
let listData: unknown[] = []
let docData: Record<string, unknown> | null = null

const DOC = {
  id: 'l1',
  title: '测试稿',
  platform: 'wechat',
  theme_id: 'modi',
  source_md: '# 你好\n\n正文段落。',
  source_ref: null,
  overrides: {},
  cover: {},
  created_at: '2026-10-13T00:00:00Z',
  updated_at: '2026-10-13T00:00:00Z',
}

vi.mock('../../api', () => ({
  layoutApi: new Proxy(
    {},
    {
      get:
        (_target, prop: string) =>
        (...args: unknown[]) => {
          ;(calls[prop] ??= []).push(args)
          if (prop === 'list') return Promise.resolve(listData)
          if (prop === 'get') return Promise.resolve(docData)
          if (prop === 'create') {
            return Promise.resolve({ ...DOC, ...(args[0] as object), id: 'new-1' })
          }
          if (prop === 'update') return Promise.resolve({ ...DOC, ...(args[1] as object) })
          if (prop === 'remove') return Promise.resolve({ ok: true })
          return Promise.resolve({ content: '', suggested_title: '' })
        },
    },
  ),
  docsApi: { list: () => Promise.resolve([]) },
}))

import { MdStudioPage } from './MdStudioPage'

const wrapper = ({ children }: { children: ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

beforeEach(() => {
  for (const key of Object.keys(calls)) delete calls[key]
  listData = [{ id: DOC.id, title: DOC.title, platform: DOC.platform, theme_id: DOC.theme_id, updated_at: DOC.updated_at }]
  docData = DOC
})

describe('MdStudioPage smoke', () => {
  it('无稿时给整页空态，点主按钮就是新建', async () => {
    listData = []
    render(<MdStudioPage />, { wrapper })
    const createBtn = await screen.findByText('mdstudio.empty.create')
    fireEvent.click(createBtn)
    await waitFor(() => expect(calls.create?.length).toBe(1))
    // 新建默认落微信平台 + 微信默认主题（墨滴）
    expect(calls.create[0][0]).toMatchObject({ platform: 'wechat', theme_id: 'modi' })
  })

  it('有稿时渲染三栏，画布挂上渲染态 DOM', async () => {
    render(<MdStudioPage />, { wrapper })
    expect(await screen.findByTestId('mdstudio-list-panel')).toBeInTheDocument()
    expect(await screen.findByTestId('mdstudio-inspector')).toBeInTheDocument()
    // 画布：applyTheme 的产出直接 appendChild（150ms 重排 debounce 之后才挂载）
    const mount = await screen.findByTestId('mdstudio-canvas-mount')
    await waitFor(() => expect(mount.childElementCount).toBeGreaterThan(0))
    expect(mount.querySelector('h1')?.textContent).toBe('你好')
  })

  it('切平台 Tab → 自动保存把 platform + 该平台默认主题 PUT 出去', async () => {
    render(<MdStudioPage />, { wrapper })
    const tab = await screen.findByRole('tab', { name: 'mdstudio.platform.xhs' })
    fireEvent.click(tab)
    // 自动保存 debounce 800ms：放宽等待窗口，不断言中间态
    await waitFor(() => expect(calls.update?.length).toBe(1), { timeout: 3000 })
    expect(calls.update[0][0]).toBe(DOC.id)
    // 小红书默认主题 = 该平台注册表第一套（桃夭）
    expect(calls.update[0][1]).toMatchObject({ platform: 'xhs', theme_id: 'taoyao' })
  })

  it('删除先弹确认 Modal，确认后才发 remove', async () => {
    render(<MdStudioPage />, { wrapper })
    const trash = await screen.findByLabelText('common.delete')
    fireEvent.click(trash)
    expect(calls.remove).toBeUndefined()
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByText('common.delete'))
    await waitFor(() => expect(calls.remove?.length).toBe(1))
    expect(calls.remove[0][0]).toBe(DOC.id)
  })

  it('色盘预设 → overrides.color 落稿（整套配色由主色派生，单一通道）', async () => {
    render(<MdStudioPage />, { wrapper })
    const swatches = await screen.findAllByLabelText('mdstudio.inspector.palettePick')
    expect(swatches.length).toBeGreaterThanOrEqual(6)
    fireEvent.click(swatches[1])
    await waitFor(() => expect(calls.update?.length).toBe(1), { timeout: 3000 })
    expect(calls.update[0][1]).toMatchObject({ overrides: { color: '#0f766e' } })
  })

  it('深色预览开关 = 切到该平台真深色主题（夜航），不是滤镜近似', async () => {
    docData = { ...DOC, platform: 'xhs', theme_id: 'taoyao' }
    listData = [{ id: DOC.id, title: DOC.title, platform: 'xhs', theme_id: 'taoyao', updated_at: DOC.updated_at }]
    render(<MdStudioPage />, { wrapper })
    const mount = await screen.findByTestId('mdstudio-canvas-mount')
    // 卡片节点在 缩放槽 > 缩放层 > 卡片 的最内层，按导出坐标系宽 1242px 认它
    const cardOf = (): HTMLElement | null =>
      Array.from(mount.querySelectorAll<HTMLElement>('*')).find((d) => d.style.width === '1242px') ?? null
    await waitFor(() => expect(cardOf()).not.toBeNull())
    const lightBg = cardOf()!.style.backgroundColor
    const toggle = await screen.findByRole('button', { name: 'mdstudio.canvas.dark' })
    fireEvent.click(toggle)
    // 150ms 重排 debounce 后应换成夜航（#10131c），且预览开关不改稿
    await waitFor(() => expect(cardOf()!.style.backgroundColor).toBe('rgb(16, 19, 28)'), { timeout: 3000 })
    // jsdom 把 #10131c 规范化为 rgb()——这就是夜航的 card 底色
    expect(lightBg).not.toBe('rgb(16, 19, 28)')
    expect(calls.update ?? []).toHaveLength(0)
  })

  it('主题自带的字号/行距会出现在下拉里（不被就近档位谎报）', async () => {
    docData = { ...DOC, platform: 'xhs', theme_id: 'taoyao' }
    listData = [{ id: DOC.id, title: DOC.title, platform: 'xhs', theme_id: 'taoyao', updated_at: DOC.updated_at }]
    render(<MdStudioPage />, { wrapper })
    // 桃夭 tokens: fontSize 30px / lineHeight 1.55，都不在预设档位里
    const size = (await screen.findByLabelText('mdstudio.inspector.fontSize')) as HTMLSelectElement
    const lh = (await screen.findByLabelText('mdstudio.inspector.lineHeight')) as HTMLSelectElement
    expect(size.value).toBe('30px')
    expect(Array.from(size.options).map((o) => o.value)).toContain('30px')
    expect(lh.value).toBe('1.55')
  })

  it('小红书平台显示二维码上传入口', async () => {    docData = { ...DOC, platform: 'xhs', theme_id: 'taoyao' }
    listData = [{ id: DOC.id, title: DOC.title, platform: 'xhs', theme_id: 'taoyao', updated_at: DOC.updated_at }]
    render(<MdStudioPage />, { wrapper })
    expect(await screen.findByTestId('mdstudio-qr-input')).toBeInTheDocument()
  })
})
