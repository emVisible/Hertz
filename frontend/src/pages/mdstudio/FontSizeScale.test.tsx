/**
 * 字号档位必须跟着**坐标系**走，不能全平台共用一组。
 *
 * 起因是一句人话：「现在这个字怎么这么小的」。查下来病根不在主题，而在**控件**：
 * 右栏那个字号下拉一直是 `['14px' … '18px']`——手机图文的尺度，1080 宽的小红书
 * 卡片也照给。于是用户在小红书下点一下那个控件（哪怕只是想"调大一点"），
 * 正文立刻掉到 16px @ 1080 = 手机上看正文的大小，卡片"字小得离谱"。
 *
 * 控件是好的，档位是错的量纲——这类错最难自查，因为它不报错、点下去还有反应。
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import '../../i18n'
import { fontSizeOptions } from './InspectorPanel'

vi.mock('../../api', () => ({
  layoutApi: new Proxy({}, { get: () => () => Promise.resolve([]) }),
  docsApi: { list: () => Promise.resolve([]) },
}))

describe('字号档位按坐标系给', () => {
  it('微信/知乎（375 / 690 逻辑宽）给手机尺度', () => {
    const sizes = fontSizeOptions('wechat', '16px')
    expect(sizes.map((s) => s.value)).toContain('16px')
    expect(sizes.map((s) => s.value)).not.toContain('36px')
  })

  it('小红书（1080 坐标系）不给出任何会让卡片"字小"的档位', () => {
    const sizes = fontSizeOptions('xhs', '36px')
    const values = sizes.map((s) => s.value)
    // 档位下限不得低于 26px：1080 宽的卡片上，再小就不是"卡片排版"而是"缩略图"
    for (const raw of values) {
      expect(parseFloat(raw), `档位 ${raw} 对 1080 宽的卡片来说太小了`).toBeGreaterThanOrEqual(26)
    }
    expect(values).toContain('36px')
  })

  it('档位里不含主题当前值以外的"陷阱"：当前值一定在选项里（否则显示的是最近那档）', () => {
    expect(fontSizeOptions('xhs', '33px').map((s) => s.value)).toContain('33px')
    expect(fontSizeOptions('wechat', '18.5px').map((s) => s.value)).toContain('18.5px')
  })

  it('两个坐标系的档位互不重叠（不会在卡片下拉里看到 14px）', () => {
    const xhs = fontSizeOptions('xhs', '36px').map((s) => s.value)
    expect(xhs).not.toContain('14px')
    expect(xhs).not.toContain('16px')
  })
})

describe('页面上真的按平台换了档位', () => {
  const baseProps = {
    footer: '',
    qr: null,
    xhsInfo: { pageCount: 1, overflow: false },
    ratio: '3:4' as const,
    coverSub: '',
    coverBadge: '',
    pageNum: true,
    header: '',
    texture: 'grid',
    deco: 'corner',
    exporting: null,
    onPlatformChange: vi.fn(),
    onThemeChange: vi.fn(),
    onOverridesChange: vi.fn(),
    onFooterChange: vi.fn(),
    onQrChange: vi.fn(),
    onExport: vi.fn(),
    onRatioChange: vi.fn(),
    onCoverFieldChange: vi.fn(),
  }

  it('小红书面板里摆的是卡片档位，出现 36px，且不出现 14px', async () => {
    const { InspectorPanel } = await import('./InspectorPanel')
    render(<InspectorPanel {...baseProps} platform={'xhs'} themeId="taoyao" overrides={{}} />)
    await screen.findByText('36px')
    const text = document.body.textContent ?? ''
    expect(text).not.toContain('14px')
  })

  it('微信面板里摆的是手机档位，出现 16px', async () => {
    const { InspectorPanel } = await import('./InspectorPanel')
    render(
      <InspectorPanel
        {...baseProps}
        platform={'wechat'}
        themeId="modi"
        overrides={{}}
      />,
    )
    await screen.findByText('16px')
  })
})
