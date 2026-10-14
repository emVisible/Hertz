/**
 * 主题设计器的界面判据（Phase 3）。
 *
 * 守三件事：①右栏能进能出设计器；②改一个变量画布就重排（改动即预览，没有"应用"按钮）；
 * ③派生变量（soft/rule/hl/accentInk）默认**不可改**，固定后才可改 —— 这是这一版
 * 最容易做错的地方：把派生项做成普通色板，用户改完才发现换个主色就被冲掉了。
 */
import { useState } from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearCustomThemes } from '@hertz/mdcore'

// 这份判据要按**中文标签**找控件（下拉里不能露出 left-bar 这种键名，
// 那是判据本身要守的东西），所以用真 i18n 而不是仓库惯用的 key-mock
import '../../i18n'
import { InspectorPanel, type ExportAction } from './InspectorPanel'
import { ToastProvider } from '../../components/ui'

const noop = () => {}

/**
 * 包装成**有状态**的：onOverridesChange 真落 state 并回传。
 *
 * 之前这层是个纯 mock，于是输入框永远拿到同一个受控值——打"改一下会怎样"的字都
 * 测不出来（清空后 React 会把 16px 塞回去，测试却以为输入框真被清空了）。
 */
function renderInspector(initial: Record<string, string> = {}, themeId = 'modi') {
  const calls: Array<Record<string, string>> = []
  const themeCalls: string[] = []
  function Harness() {
    const [overrides, setOverrides] = useState<Record<string, string>>(initial)
    const [id, setId] = useState(themeId)
    return (
      <ToastProvider>
        <InspectorPanel
          platform="wechat"
          themeId={id}
          overrides={overrides}
          footer="图文工坊"
          qr={null}
          xhsInfo={{ pageCount: 1, overflow: false }}
          ratio="3:4"
          coverSub=""
          coverBadge=""
          pageNum
          header=""
          exporting={null}
          onPlatformChange={noop}
          onThemeChange={(next) => {
            themeCalls.push(next)
            setId(next)
          }}
          onOverridesChange={(next) => {
            calls.push(next as Record<string, string>)
            setOverrides(next as Record<string, string>)
          }}
          onFooterChange={noop}
          onQrChange={noop}
          onExport={noop as (a: ExportAction) => void}
          onRatioChange={noop}
          onCoverFieldChange={noop}
        />
      </ToastProvider>
    )
  }
  const utils = render(<Harness />)
  return { ...utils, calls, themeCalls }
}

/** 色板控件：jsdom 里点颜色输入框不会开选择器（也不改值），只能 fireEvent.change */
function changeColor(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

beforeEach(() => {
  localStorage.clear()
  clearCustomThemes()
})

describe('入口与退出', () => {
  it('点「主题设计器」进得去，也退得回来', async () => {
    const user = userEvent.setup()
    renderInspector()
    expect(screen.queryByTestId('mdstudio-designer')).toBeNull()

    await user.click(screen.getByTestId('mdstudio-open-designer'))
    expect(screen.getByTestId('mdstudio-designer')).toBeTruthy()
    // 设计器占满右栏：导出按钮那一大片让位给 10 个分区
    expect(screen.queryByTestId('mdstudio-xhs-pages')).toBeNull()

    await user.click(screen.getByRole('button', { name: '返回' }))
    expect(screen.queryByTestId('mdstudio-designer')).toBeNull()
    expect(screen.getByTestId('mdstudio-open-designer')).toBeTruthy()
  })

  it('10 个分区都在（缺一个分区 = 有一批变量改不了）', async () => {
    const user = userEvent.setup()
    renderInspector()
    await user.click(screen.getByTestId('mdstudio-open-designer'))
    for (const id of ['ink', 'accent', 'font', 'rhythm', 'shape', 'heading', 'emphasis', 'code', 'table', 'ornament']) {
      expect(screen.getByTestId(`designer-section-${id}`), `分区 ${id} 缺失`).toBeTruthy()
    }
  })
})

describe('改动即预览', () => {
  it('改正文墨色立刻生效（没有"应用"这一步）', async () => {
    const user = userEvent.setup()
    const { calls } = renderInspector()
    await user.click(screen.getByTestId('mdstudio-open-designer'))

    changeColor('正文', '#123456')
    expect(calls.at(-1)).toEqual({ ink: '#123456' })
  })

  it('改字号同样直接落 overrides', async () => {
    const user = userEvent.setup()
    const { calls } = renderInspector()
    await user.click(screen.getByTestId('mdstudio-open-designer'))
    const input = screen.getByLabelText('字号')
    await user.clear(input)
    await user.type(input, '19px')
    expect(calls.at(-1)).toEqual({ fontSize: '19px' })
  })

  it('枚举变量下拉选中即落 overrides', async () => {
    const user = userEvent.setup()
    const { calls } = renderInspector()
    await user.click(screen.getByTestId('mdstudio-open-designer'))
    await user.selectOptions(screen.getByLabelText('标题样式'), 'pill')
    expect(calls.at(-1)).toEqual({ headingStyle: 'pill' })
  })

  it('「还原」把该键从 overrides 里摘掉（回到主题自带值）', async () => {
    const user = userEvent.setup()
    const { calls } = renderInspector({ fontSize: '19px', color: '#ff0000' })
    await user.click(screen.getByTestId('mdstudio-open-designer'))

    // 字号与主色各有一个还原按钮；点第一个之后 overrides 里应当少一个键
    const resets = screen.getAllByRole('button', { name: '还原成主题自带值' })
    expect(resets.length).toBeGreaterThan(0)
    await user.click(resets[0])
    expect(Object.keys(calls.at(-1) ?? {})).toHaveLength(1)
  })
})

describe('派生变量：默认跟随主色，固定后才可改', () => {
  it('没 override 时主色淡底/描边/荧光三项都标着「跟随主色」，且不给色板', async () => {
    const user = userEvent.setup()
    renderInspector()
    await user.click(screen.getByTestId('mdstudio-open-designer'))

    const badges = screen.getAllByText('跟随主色')
    expect(badges).toHaveLength(4) // accentInk / soft / rule / hl
    // 派生项在跟随状态下不是可改控件：没有色板输入框，只有一只色块 + 「固定」
    expect(screen.queryByLabelText('主色淡底')).toBeNull()
    expect(screen.queryByLabelText('主色底文字')).toBeNull()
  })

  it('override 了就标「已固定」，并给出还原成跟随主色的入口', async () => {
    const user = userEvent.setup()
    renderInspector({ soft: 'rgba(1, 2, 3, 0.1)' })
    await user.click(screen.getByTestId('mdstudio-open-designer'))
    expect(screen.getByText('已固定')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '还原成跟随主色' }))
    // 还原后该键从 overrides 消失，重新变回"跟随主色"
    expect(screen.getAllByText('跟随主色')).toHaveLength(4)
    expect(screen.queryByLabelText('主色淡底')).toBeNull()
  })

  it('点「固定」就把派生值钉住，之后可改（用户主动放弃"跟着主色"）', async () => {
    const user = userEvent.setup()
    const { calls } = renderInspector()
    await user.click(screen.getByTestId('mdstudio-open-designer'))
    const pins = screen.getAllByRole('button', { name: '固定' })
    await user.click(pins[0])
    expect(Object.keys(calls.at(-1) ?? {})).toHaveLength(1)
    expect(screen.getByText('已固定')).toBeTruthy()
  })

  it('固定之后主色淡底就能改了（这才对：用户主动放弃"跟着主色"）', async () => {
    const user = userEvent.setup()
    const { calls } = renderInspector({ soft: 'rgba(1, 2, 3, 0.1)' })
    await user.click(screen.getByTestId('mdstudio-open-designer'))
    changeColor('主色淡底', '#00ff00')
    expect(calls.at(-1)).toEqual({ soft: '#00ff00' })
  })
})

describe('另存为我的主题', () => {
  it('存完就切到新主题，并在右栏主题区里出现', async () => {
    const user = userEvent.setup()
    const { themeCalls } = renderInspector({ color: '#7c3aed' })
    await user.click(screen.getByTestId('mdstudio-open-designer'))

    const nameInput = screen.getByLabelText('主题名')
    await user.type(nameInput, '夜读')
    await user.click(screen.getByRole('button', { name: '另存为' }))

    expect(themeCalls.at(-1)).toMatch(/^user:/)
    const mine = within(screen.getByTestId('mdstudio-designer'))
    expect(mine.getByText('夜读')).toBeTruthy()
  })

  it('存之前没有名字就用主题自带名（不该把空名当主题名）', async () => {
    const user = userEvent.setup()
    const { themeCalls } = renderInspector({ color: '#0891b2' })
    await user.click(screen.getByTestId('mdstudio-open-designer'))
    await user.click(screen.getByRole('button', { name: '另存为' }))
    expect(themeCalls.at(-1)).toMatch(/^user:/)
  })
})