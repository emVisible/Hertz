/** 批量出图队列的判据（§10 候选 4）。
 *
 * 钉的是队列本身的行为，不是截图：出图引擎与 zip 打包都在边界上打桩，
 * 真产物字节由 mdcore 自己的导出测试负责（jsdom 给不了 canvas）。
 *
 * ① 逐篇出图、篇名进 ZIP 条目名，成品是一个包而不是 N 次下载；
 * ② 单篇失败不掐断整批（这是队列相对「连点 N 次导出按钮」的唯一理由）；
 * ③ 取消只停后续，已出的条目照样打包交付；
 * ④ 小红书出卡片组、其余平台出长图——与单篇导出同一套平台判定。
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock 的工厂会被提升到文件顶部，引用的桩必须先进 hoisted 作用域
const h = vi.hoisted(() => {
  const exportCards = vi.fn(async (pages: HTMLElement[]) =>
    pages.map((_, i) => new Blob([`card-${i}`])),
  )
  const renderLongImage = vi.fn(async (_el: HTMLElement) => new Blob(['long']))
  const zipBlobs = vi.fn(async (_entries: Array<{ name: string; blob: Blob }>) => new Blob(['zip']))
  const clicks: string[] = []
  const DOCS: Record<string, Record<string, unknown>> = {
    a: {
      id: 'a',
      title: '小红书稿',
      platform: 'xhs',
      theme_id: 'taoyao',
      source_md: '# 标题\n\n正文一段。\n\n正文二段。',
      overrides: {},
      cover: { footer: '署名', qr: null, breaks: [1] },
    },
    b: {
      id: 'b',
      title: '公众号稿',
      platform: 'wechat',
      theme_id: 'modi',
      source_md: '正文。',
      overrides: {},
      cover: {},
    },
    empty: {
      id: 'empty',
      title: '空稿',
      platform: 'xhs',
      theme_id: 'taoyao',
      source_md: '  ',
      overrides: {},
      cover: {},
    },
    c: {
      id: 'c',
      title: '第二篇',
      platform: 'wechat',
      theme_id: 'modi',
      source_md: '另一篇正文。',
      overrides: {},
      cover: {},
    },
  }
  return { exportCards, renderLongImage, zipBlobs, clicks, DOCS }
})
const { exportCards, renderLongImage, zipBlobs, clicks } = h

vi.mock('@hertz/mdcore', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, exportCards: h.exportCards, renderLongImage: h.renderLongImage, zipBlobs: h.zipBlobs }
})

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) }
})

vi.mock('../../api', () => ({
  layoutApi: {
    get: (id: string) =>
      id === 'boom' ? Promise.reject(new Error('渲染炸了')) : Promise.resolve(h.DOCS[id] ?? h.DOCS.b),
  },
}))

import { BatchExportModal, type BatchTarget } from './BatchExportModal'

const TARGETS: BatchTarget[] = [
  { id: 'a', title: '小红书稿', platform: 'xhs' },
  { id: 'b', title: '公众号稿', platform: 'wechat' },
]

beforeEach(() => {
  exportCards.mockClear()
  renderLongImage.mockClear()
  zipBlobs.mockClear()
  clicks.length = 0
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicks.push(this.download)
  })
})

describe('BatchExportModal', () => {
  it('逐篇出图并打成一个 ZIP：条目按「序号-稿名/页码.png」分层', async () => {
    render(<BatchExportModal open targets={TARGETS} onClose={() => {}} />)
    fireEvent.click(screen.getByText('mdstudio.batch.start'))

    await waitFor(() => expect(zipBlobs).toHaveBeenCalledTimes(1))
    const entries = zipBlobs.mock.calls[0][0] as Array<{ name: string }>
    // 第一篇小红书出卡片组（正文两段 + 标题 → 至少两页），第二篇出长图
    expect(entries.some((e) => e.name.startsWith('01-小红书稿/page-01.png'))).toBe(true)
    expect(entries.some((e) => e.name === '02-公众号稿/long.png')).toBe(true)
    // 一次交付一个包，而不是两次下载
    expect(clicks).toHaveLength(1)
    expect(clicks[0]).toMatch(/^mdstudio-batch-\d{8}-\d{4}\.zip$/)
  })

  it('小红书走卡片组、微信走长图（平台判定与单篇导出同一套）', async () => {
    render(<BatchExportModal open targets={TARGETS} onClose={() => {}} />)
    fireEvent.click(screen.getByText('mdstudio.batch.start'))
    await waitFor(() => expect(renderLongImage).toHaveBeenCalledTimes(1))
    expect(exportCards).toHaveBeenCalledTimes(1)
    expect(exportCards.mock.calls[0][0].length).toBeGreaterThan(1)
  })

  it('单篇失败不掐断整批：失败篇记原因，后面的照常出', async () => {
    render(
      <BatchExportModal
        open
        targets={[
          { id: 'boom', title: '会炸的稿', platform: 'wechat' },
          { id: 'b', title: '公众号稿', platform: 'wechat' },
        ]}
        onClose={() => {}}
      />,
    )
    fireEvent.click(screen.getByText('mdstudio.batch.start'))
    await waitFor(() => expect(zipBlobs).toHaveBeenCalledTimes(1))
    // 整批仍然交付了第二篇的产物
    const entries = zipBlobs.mock.calls[0][0] as Array<{ name: string }>
    expect(entries.map((e) => e.name)).toEqual(['02-公众号稿/long.png'])
  })

  it('空源文的稿被跳过并说明原因，不白跑一次截图', async () => {
    render(
      <BatchExportModal
        open
        targets={[
          { id: 'empty', title: '空稿', platform: 'xhs' },
          { id: 'b', title: '公众号稿', platform: 'wechat' },
        ]}
        onClose={() => {}}
      />,
    )
    fireEvent.click(screen.getByText('mdstudio.batch.start'))
    await waitFor(() => expect(zipBlobs).toHaveBeenCalledTimes(1))
    expect(exportCards).not.toHaveBeenCalled()
  })

  it('没有任何产物时不下载，只报「没有可导出的产物」', async () => {
    render(<BatchExportModal open targets={[{ id: 'empty', title: '空稿', platform: 'xhs' }]} onClose={() => {}} />)
    fireEvent.click(screen.getByText('mdstudio.batch.start'))
    await waitFor(() => expect(screen.getByText('mdstudio.batch.state.skipped')).toBeInTheDocument())
    expect(zipBlobs).not.toHaveBeenCalled()
    expect(clicks).toHaveLength(0)
  })

  it('取消：运行中点取消只停后续，已出的条目照样打包', async () => {
    let release = () => {}
    renderLongImage.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return new Blob(['long'])
    })
    render(
      <BatchExportModal
        open
        targets={[
          { id: 'b', title: '公众号稿', platform: 'wechat' },
          { id: 'c', title: '第二篇', platform: 'wechat' },
        ]}
        onClose={() => {}}
      />,
    )
    fireEvent.click(screen.getByText('mdstudio.batch.start'))
    await waitFor(() => expect(renderLongImage).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByText('mdstudio.batch.cancel'))
    release()
    await waitFor(() => expect(zipBlobs).toHaveBeenCalledTimes(1))
    const entries = zipBlobs.mock.calls[0][0] as Array<{ name: string }>
    expect(entries).toHaveLength(1)
    expect(renderLongImage).toHaveBeenCalledTimes(1)
  })
})