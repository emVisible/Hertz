/**
 * 切平台必须**换成那个平台的样子**，而且换回来时你那份配置还在。
 *
 * 起因是人话四连里的一句：「不同栏目需要有对应的配置缓存，比如我从小红书切换到知乎，
 * 就应该直接换到知乎上，我发现现在切换会有样式污染」。
 *
 * 病根查出来很干脆：`changePlatform` 换了 `theme_id`，**却没换 `overrides`**。
 * 于是小红书上调过的每一项——字号 36px（卡片档位）、主色 #ff2442、投影、描边——
 * 原封不动跟着进知乎：一篇 690 宽的文章用 36px 正文，标题撑成两行、表格挤成竖条、
 * 引文一大块。用户看到的现象是「部分 md 渲染不完全，比如标题渲染」+「样式污染」，
 * 而根子上是**一个跨栏目共用的配置袋**。
 *
 * 配置按栏目分别存在 `cover.platform_overrides`（cover 是后端预留的自由 JSON 槽，
 * 存得下、且随稿入库——刷新页面不丢）。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 刻意**不**初始化 i18n：这样 label / tab 文本保持成 i18n key（如
 * `mdstudio.inspector.fontSize`），断言读 key 而不是中文文案——改文案不会逼着改判据。
 */
const updates: Array<Record<string, unknown>> = []

const BASE: Record<string, unknown> = {
  id: 'l1',
  title: '切换稿',
  platform: 'xhs',
  theme_id: 'taoyao',
  source_md: '# 标题\n\n正文一段。',
  overrides: {},
  cover: { footer: '图文工坊' },
  created_at: '2026-10-15T00:00:00Z',
  updated_at: '2026-10-15T00:00:00Z',
}

let docData: Record<string, unknown>

vi.mock('../../api', () => ({
  layoutApi: {
    list: () =>
      Promise.resolve([
        { id: 'l1', title: '切换稿', platform: 'xhs', theme_id: 'taoyao', updated_at: '' },
      ]),
    get: () => Promise.resolve(docData),
    update: (_id: string, patch: Record<string, unknown>) => {
      updates.push(patch)
      return Promise.resolve({ ok: true })
    },
  },
  docsApi: { list: () => Promise.resolve([]) },
}))

import { defaultThemeFor, getTheme } from '@hertz/mdcore'

import { MdStudioPage } from './MdStudioPage'

const wrapper = ({ children }: { children: ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

beforeEach(() => {
  docData = { ...BASE, overrides: {}, cover: { footer: '图文工坊' } }
  updates.length = 0
  localStorage.clear()
})

/** 读下拉框当前值：字号档位最能说明问题（36px @ 690 宽的文章 = 标题全炸） */
async function currentFontSize(): Promise<string> {
  const el = (await screen.findByLabelText('mdstudio.inspector.fontSize')) as HTMLSelectElement
  return el.value
}

describe('切平台不带走上一栏的样式（样式污染）', () => {
  it('小红书上调过字号 → 切到知乎，知乎不继承那个字号', async () => {
    const user = userEvent.setup()
    render(<MdStudioPage />, { wrapper })
    const before = await currentFontSize()
    expect(before).toBe('36px')

    await act(async () => {
      await user.click(screen.getByRole('tab', { name: 'mdstudio.platform.zhihu' }))
    })

    // 知乎默认主题是 16px 那一档；最关键的是**不能还是 36px**
    await waitFor(async () => expect(await currentFontSize()).not.toBe('36px'))
  })

  it('切平台后 overrides 落库成"该栏目自己那份"，不是把上一栏那份原样带过去', async () => {
    const user = userEvent.setup()
    render(<MdStudioPage />, { wrapper })
    await currentFontSize()

    await act(async () => {
      await user.click(screen.getByRole('tab', { name: 'mdstudio.platform.zhihu' }))
    })
    await waitFor(() => expect(updates.length).toBeGreaterThan(0))

    const patch = updates[updates.length - 1]
    // 落库的 overrides 不能含小红书的 36px 字号
    const persisted = (patch.overrides ?? {}) as Record<string, unknown>
    expect(persisted.fontSize).not.toBe('36px')
    // 配置按栏目存档了
    const cover = (patch.cover ?? {}) as Record<string, unknown>
    const perPlatform = cover.platform_overrides as Record<string, Record<string, unknown>>
    // 只存**去过**的栏目：没去过的没必要占一格（`overrides` 缺省就是空配置）
    expect(Object.keys(perPlatform)).toEqual(['xhs'])
    // 小红书那份还留着（换回来还能用）
    expect(perPlatform.xhs).toBeTruthy()
    // 主题也按栏目记着，换回来不用重新挑
    expect((cover.platform_themes as Record<string, string>).xhs).toBe('taoyao')
  })
})

describe('换回来时你那份配置还在（配置缓存）', () => {
  it('小红书调过的样式，切走再切回来还在', async () => {
    const user = userEvent.setup()
    render(<MdStudioPage />, { wrapper })
    const xhsSize = await currentFontSize()
    expect(xhsSize).toBe('36px')

    await act(async () => {
      await user.click(screen.getByRole('tab', { name: 'mdstudio.platform.zhihu' }))
    })
    await waitFor(async () => expect(await currentFontSize()).not.toBe('36px'))

    await act(async () => {
      await user.click(screen.getByRole('tab', { name: 'mdstudio.platform.xhs' }))
    })
    // 关键：小红书那份配置被还回来了，而不是被知乎的覆盖
    await waitFor(async () => expect(await currentFontSize()).toBe(xhsSize))
  })

  it('没去过的栏目用该栏默认主题与空配置（不是上一栏的）', async () => {
    const user = userEvent.setup()
    render(<MdStudioPage />, { wrapper })
    await currentFontSize()
    await act(async () => {
      await user.click(screen.getByRole('tab', { name: 'mdstudio.platform.zhihu' }))
    })
    await waitFor(() => expect(updates.length).toBeGreaterThan(0))
    const patch = updates[updates.length - 1]
    // 没去过的栏目：直播字段（overrides/theme_id）就是该栏的默认值，不是上一栏的
    expect(patch.overrides).toEqual({})
    // 默认主题读源头，不写死 id：注册顺序变了这条不该红
    expect(patch.theme_id).toBe(defaultThemeFor('zhihu').id)
    // 而且**它属于知乎**——拿小红书主题渲染知乎文章，换平台就等于没换
    expect(getTheme(patch.theme_id as string).platform).toBe('zhihu')
  })
})
