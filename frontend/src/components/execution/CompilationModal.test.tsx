/** 多素材合集编排面板（v0.35）——`CompilationModal`。
 *
 * 钉住三件「看着是界面小事、错了就静默出错」的事：
 *
 * 1. **第一段没有入场转场**。服务端会强制落成 cut（片段 2 有「从它入场」，
 *    片段 1 没有「从更早的东西入场」）。面板若给首段也发 transition，服务端
 *    归一化后与界面显示不一致——用户看到的顺序和存下去的不一样。
 * 2. **请求发的是英文档名**。界面上是中文（淡入淡出/擦除…），发过去必须
 *    是 `fade`/`wipe`。发中文 → 422 → 界面只表现为「建不出来」。
 * 3. **时长预估只在数据齐时显示**。候选接口不给 duration（后端没探测），
 *    所以不完整时宁可不显示，也不编一个数字——假的预估比没有更坏。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock 工厂会被提升到 import 之前，若在工厂体里直接引用模块级 const
// （TDZ）会在初始化前求值 → vitest 收集阶段就挂住（实测：整文件静默卡死，
// 连 RUN 之后的第一条用例都不出现）。所以用全局中转，工厂只碰它。
const g = globalThis as { __createCalls?: unknown[] }

// MediaThumb 走 PipelineStage → api barrel → 真实 client，在 jsdom 里会拉起
// 网络层并挂住。这里 mock 掉：面板的测试关心的是「请求体对不对」，不是缩略图
// 渲染（那是 MediaThumb 自己的测试范围）。
vi.mock('./PipelineStage', async () => {
  const { createElement } = await import('react')
  return {
  MediaThumb: () => createElement('div', { 'data-testid': 'thumb' }),
  ITEM_TYPE_BADGE: {},
  PIPELINE_ITEM_TONE: {},
  }
})

vi.mock('../../api/pipeline', () => ({
  pipelineApi: {
    compilationSources: vi.fn(async () => [
      { id: 'a', title: '素材 A', item_type: 'video_raw', raw_path: '/x/a.mp4', cover_path: null, duration_s: 10 },
      { id: 'b', title: '素材 B', item_type: 'video_raw', raw_path: '/x/b.mp4', cover_path: null, duration_s: 20 },
      { id: 'c', title: '素材 C', item_type: 'image_gallery', raw_path: '/x/c.jpg', cover_path: null, duration_s: 5 },
    ]),
    createCompilation: vi.fn(async (body: unknown) => {
      ;(g.__createCalls ??= []).push(body)
      return { id: 'new', title: 't', status: 'downloaded', clips: { clips: [] } }
    }),
  },
}))

import { CompilationModal } from './CompilationModal'

const wrapper = ({ children }: { children: ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

function open(initialIds?: string[]) {
  // key 与调用方一致：每次打开重建内部 state（组件用 key 而不是 effect 重置）
  return render(
    <CompilationModal key="open" open onClose={() => {}} initialIds={initialIds} />,
    { wrapper },
  )
}

const createCalls = (): unknown[] => (g.__createCalls ??= [])

beforeEach(() => {
  g.__createCalls = []
})

/** 在素材池里按标题点选（编排区也有同名元素，必须限定作用域）。 */
function pick(title: string) {
  const pool = screen.getByTestId('compilation-pool')
  fireEvent.click(within(pool).getByText(title))
}

/** 编排区（已选序列）里的标题——用于断言顺序与间隙。 */
function sequence() {
  return screen.getByTestId('compilation-sequence')
}

/** 等编排区出现（池子先到、序列区后到，两者不是同一时刻）。 */
/** 创建按钮——用 role 定位而不是文本：按钮里同时有 spinner 的 aria-label，
 *  getByText 在文本被拆成多个节点时会歧义。 */
function createButton() {
  return screen.getByRole('button', { name: /console.compilation.create/ })
}

async function waitSequence(text: string) {
  await waitFor(() => expect(within(sequence()).getByText(text)).toBeInTheDocument())
}

describe('CompilationModal', () => {
  it('未打开时不渲染任何东西', () => {
    const { container } = render(
      <CompilationModal open={false} onClose={() => {}} />,
      { wrapper },
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('打开后带出预选片段并列出顺序', async () => {
    open(['a', 'b'])
    await waitSequence('素材 A')
    // 素材池与编排区都会出现同名标题——两栏各自独立，故用 testid 限定
    expect(within(sequence()).getByText('素材 A')).toBeInTheDocument()
    expect(within(sequence()).getByText('素材 B')).toBeInTheDocument()
  })

  it('首段没有间隙转场，片段 2 起才有', async () => {
    open(['a', 'b', 'c'])
    await waitSequence('素材 C')
    // 两个间隙 = 2 个转场选择器；首段之前不该有一个
    expect(within(sequence()).getAllByLabelText('console.compilation.transition')).toHaveLength(2)
  })

  it('创建时请求体：首段无 transition，其余带英文档名', async () => {
    open(['a', 'b'])
    await waitSequence('素材 B')

    // 把第 1、2 段之间的转场改成「擦除」（界面上是中文，发出去必须是 wipe）
    const [gapSelect] = within(sequence()).getAllByLabelText('console.compilation.transition')
    fireEvent.change(gapSelect, { target: { value: 'wipe' } })

    fireEvent.click(createButton())

    await waitFor(() => expect(createCalls()).toHaveLength(1))
    const body = createCalls()[0] as { clips: Array<Record<string, unknown>> }
    expect(body.clips[0]).toEqual({ item_id: 'a' })
    expect(body.clips[0].transition).toBeUndefined()
    expect(body.clips[1]).toMatchObject({ item_id: 'b', transition: 'wipe' })
  })

  it('默认转场是硬切（cut），不是某一种花哨效果', async () => {
    open(['a', 'b'])
    await waitSequence('素材 B')
    fireEvent.click(createButton())
    await waitFor(() => expect(createCalls()).toHaveLength(1))
    const body = createCalls()[0] as { clips: Array<Record<string, unknown>> }
    expect(body.clips[1].transition).toBe('cut')
  })

  it('只选 1 段也能建（合集从一条起步是合法状态）', async () => {
    open(['a'])
    await waitSequence('素材 A')
    expect(within(sequence()).queryAllByLabelText('console.compilation.transition')).toHaveLength(0)
    fireEvent.click(createButton())
    await waitFor(() => expect(createCalls()).toHaveLength(1))
  })

  it('创建按钮在未选片段时禁用', async () => {
    open([])
    await waitFor(() => expect(within(sequence()).getByText(/console.compilation.pickFirst/)).toBeInTheDocument())
    expect(createButton()).toBeDisabled()
  })

  it('时长预估在数据齐时显示（含转场扣减）', async () => {
    // 10s + 20s，淡入淡出 0.6s 重叠 → 29.4 ≈ 29
    open(['a', 'b'])
    await waitSequence('素材 B')
    const [gapSelect] = within(sequence()).getAllByLabelText('console.compilation.transition')
    fireEvent.change(gapSelect, { target: { value: 'fade' } })
    await waitFor(() => {
      expect(screen.getByText(/console.compilation.estimate/)).toBeInTheDocument()
    })
  })

  it('在池子里点选会加入序列、再次点击会移除', async () => {
    open(['a'])                       // 预选 A
    await waitSequence('素材 A')

    pick('素材 B')                     // 加 B
    await waitSequence('素材 B')
    expect(within(sequence()).getByText('素材 A')).toBeInTheDocument()

    pick('素材 A')                     // 再点 A = 取消
    await waitFor(() =>
      expect(within(sequence()).queryByText('素材 A')).toBeNull(),
    )
    expect(within(sequence()).getByText('素材 B')).toBeInTheDocument()
  })

  it('标题留空时发 null（服务端据此自动生成标题）', async () => {
    open(['a'])
    await waitSequence('素材 A')
    fireEvent.click(createButton())
    await waitFor(() => expect(createCalls()).toHaveLength(1))
    expect((createCalls()[0] as { title: unknown }).title).toBeNull()
  })
})