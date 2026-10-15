/**
 * 回收站与版本历史的页级判据（W2 数据安全剩下的一半）。
 *
 * 后端已就位（软删 + `layout_revisions`），这里守的是**界面那一半**：
 * ①删除的稿子**看得见、捞得回**——用户得知道"它没真没"；
 * ②"彻底删除"要显式、且不与"删除"混成一个按钮（点错一次无法挽回的那类操作）；
 * ③版本历史能给"回到某一版"，而且**这一步本身可逆**（服务端会先给当前内容留一份）。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import '../../i18n'

const live = [
  { id: 'l1', title: '活着的稿', platform: 'wechat', theme_id: 'modi', updated_at: '2026-10-15T00:00:00Z' },
]
const trash = [
  {
    id: 'l9',
    title: '误删的稿',
    platform: 'xhs',
    theme_id: 'taoyao',
    updated_at: '2026-10-15T00:00:00Z',
    deleted_at: '2026-10-15T01:00:00Z',
  },
]
const revisions = {
  revisions: [
    { seq: 3, title: '活着的稿', created_at: '2026-10-15T02:00:00Z', preview: '# 旧版正文', chars: 120 },
    { seq: 2, title: '活着的稿', created_at: '2026-10-15T01:30:00Z', preview: '# 更旧', chars: 90 },
  ],
}

const calls: string[] = []

/** 自动保存的挂起闸门：能卡住 PUT，才能验「写快照 → 保存成功 → 清快照」的时序 */
let holdUpdates = false
let releaseUpdates: (() => void) | null = null

const DOC = {
  ...live[0],
  source_md: '# 标题\n\n正文。',
  source_ref: null,
  overrides: {},
  cover: {},
  created_at: '2026-10-15T00:00:00Z',
}

vi.mock('../../api', () => ({
  layoutApi: {
    list: () => Promise.resolve(live),
    listDeleted: () => Promise.resolve(trash),
    get: () => Promise.resolve(DOC),
    revisions: () => Promise.resolve(revisions),
    update: () => {
      if (!holdUpdates) return Promise.resolve(DOC)
      return new Promise((resolve) => {
        releaseUpdates = () => resolve(DOC)
      })
    },
    remove: (id: string) => {
      calls.push(`remove:${id}`)
      return Promise.resolve({ ok: true })
    },
    restore: (id: string) => {
      calls.push(`restore:${id}`)
      return Promise.resolve(DOC)
    },
    purge: (id: string) => {
      calls.push(`purge:${id}`)
      return Promise.resolve({ ok: true })
    },
    restoreRevision: (id: string, seq: number) => {
      calls.push(`restoreRevision:${id}:${seq}`)
      return Promise.resolve(DOC)
    },
  },
  docsApi: { list: () => Promise.resolve([]) },
}))

import { MdStudioPage } from './MdStudioPage'

const wrapper = ({ children }: { children: ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

beforeEach(() => {
  calls.length = 0
  localStorage.clear()
  holdUpdates = false
  releaseUpdates = null
})

describe('回收站：删掉的稿子捞得回来', () => {
  it('列表里有回收站入口，点开能看到被删的稿', async () => {
    const user = userEvent.setup()
    render(<MdStudioPage />, { wrapper })
    await waitFor(() => expect(screen.getByTestId('mdstudio-list-panel')).toBeTruthy())

    await user.click(await screen.findByTestId('mdstudio-trash-toggle'))
    await waitFor(() => expect(screen.getByText('误删的稿')).toBeTruthy())
  })

  it('点「恢复」调的是 restore，不是再删一次', async () => {
    const user = userEvent.setup()
    render(<MdStudioPage />, { wrapper })
    await user.click(await screen.findByTestId('mdstudio-trash-toggle'))
    await user.click(await screen.findByTestId('mdstudio-trash-restore-l9'))
    await waitFor(() => expect(calls).toContain('restore:l9'))
    expect(calls.some((c) => c.startsWith('purge'))).toBe(false)
  })

  it('「彻底删除」与「删除」是两个按钮，不共用一个（点错一次无法挽回）', async () => {
    const user = userEvent.setup()
    render(<MdStudioPage />, { wrapper })
    await user.click(await screen.findByTestId('mdstudio-trash-toggle'))
    // 回收站里是恢复 + 彻底删除两个独立动作
    expect(await screen.findByTestId('mdstudio-trash-restore-l9')).toBeTruthy()
    expect(screen.getByTestId('mdstudio-trash-purge-l9')).toBeTruthy()
  })

  it('彻底删除要二次确认（不可逆的操作不该一击生效）', async () => {
    const user = userEvent.setup()
    render(<MdStudioPage />, { wrapper })
    await user.click(await screen.findByTestId('mdstudio-trash-toggle'))
    await user.click(await screen.findByTestId('mdstudio-trash-purge-l9'))
    // 第一击只是弹出确认，还没调接口
    expect(calls.some((c) => c.startsWith('purge'))).toBe(false)
    await user.click(await screen.findByTestId('mdstudio-purge-confirm'))
    await waitFor(() => expect(calls).toContain('purge:l9'))
  })
})

describe('版本历史：能回到某一版', () => {
  it('能打开历史并看到各版摘要', async () => {
    const user = userEvent.setup()
    render(<MdStudioPage />, { wrapper })
    await waitFor(() => expect(document.querySelector('.mdcore-doc')).toBeTruthy(), { timeout: 5000 })
    await user.click(await screen.findByTestId('mdstudio-history-open'))
    await waitFor(() => expect(screen.getByText('# 旧版正文')).toBeTruthy())
  })

  it('回到某一版调的是 restoreRevision（服务端会先留一份，所以这一步可逆）', async () => {
    const user = userEvent.setup()
    render(<MdStudioPage />, { wrapper })
    await waitFor(() => expect(document.querySelector('.mdcore-doc')).toBeTruthy(), { timeout: 5000 })
    await user.click(await screen.findByTestId('mdstudio-history-open'))
    await user.click(await screen.findByTestId('mdstudio-revision-3'))
    await waitFor(() => expect(calls).toContain('restoreRevision:l1:3'))
  })
})
/**
 * 自动保存加固的**页级**判据。
 *
 * 上面 `localDraft.test.ts` 只验了纯函数，而两处接线（改动要写快照、落库成功要清）
 * 变异时全绿——纯函数写得再对，没接进页面就是零。所以这里从页面驱动一次真实保存。
 */
describe('本地快照接在自动保存上', () => {
  it('改动后本地立刻有快照（不等 800ms debounce）', async () => {
    const user = userEvent.setup()
    render(<MdStudioPage />, { wrapper })
    await waitFor(() => expect(document.querySelector('.cm-content')).toBeTruthy(), { timeout: 5000 })
    // 首屏加载完成后会写一次快照（那是「打开即留底」），此处只需确认画布已就绪
    await waitFor(() => expect(document.querySelector('.mdcore-doc')).toBeTruthy(), { timeout: 5000 })

    await user.type(document.querySelector('.cm-content') as HTMLElement, '甲乙丙')
    // 不用等 debounce：改动就应当立刻留底
    await waitFor(() => {
      const raw = localStorage.getItem('hertz:mdstudio:draft:l1')
      expect(raw, '改动后本地没有快照 = 保存失败就只剩内存').toBeTruthy()
    })
  })

  it('保存卡住时快照留着；保存成功后清掉（第二真相源不能留）', async () => {
    const user = userEvent.setup()
    holdUpdates = true // 先卡住 PUT，才看得到中间态
    render(<MdStudioPage />, { wrapper })
    await waitFor(() => expect(document.querySelector('.cm-content')).toBeTruthy(), { timeout: 5000 })
    await user.type(document.querySelector('.cm-content') as HTMLElement, '甲')
    await waitFor(() => expect(localStorage.getItem('hertz:mdstudio:draft:l1')).toBeTruthy(), {
      timeout: 3000,
    })

    // PUT 还挂着 → 快照必须**留着**：它是这段内容的唯一副本
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1200))
    })
    expect(
      localStorage.getItem('hertz:mdstudio:draft:l1'),
      '保存还没成功就清快照 —— 真失败时内容就没了',
    ).toBeTruthy()

    // 放行 PUT → 快照才该清
    await act(async () => {
      releaseUpdates?.()
    })
    await waitFor(() => expect(localStorage.getItem('hertz:mdstudio:draft:l1')).toBeNull(), {
      timeout: 5000,
    })
  })
})
