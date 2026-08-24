import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { DEFAULT_PRODUCE_OPTIONS, ProduceOptionsPicker } from './ProduceOptionsPicker'

describe('ProduceOptionsPicker', () => {
  it('点击配音模块 → onChange 携带 voice=true 且本地 active 高亮', () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <ProduceOptionsPicker value={{ ...DEFAULT_PRODUCE_OPTIONS }} onChange={onChange} />,
    )
    const voiceBtn = screen.getByTitle('console.produce.voiceHint')
    expect(voiceBtn.className).not.toContain('bg-primary/15')
    fireEvent.click(voiceBtn)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange.mock.calls[0][0]).toMatchObject({ voice: true, passthrough: false })
    // 重渲染新 value → active class 切换
    rerender(
      <ProduceOptionsPicker
        value={{ ...DEFAULT_PRODUCE_OPTIONS, voice: true }}
        onChange={onChange}
      />,
    )
    expect(screen.getByTitle('console.produce.voiceHint').className).toContain('bg-primary/15')
  })

  it('取消直发 → 回退翻译+字幕组合', () => {
    const onChange = vi.fn()
    render(<ProduceOptionsPicker value={{ ...DEFAULT_PRODUCE_OPTIONS }} onChange={onChange} />)
    fireEvent.click(screen.getByTitle('console.produce.passthroughHint'))
    expect(onChange.mock.calls[0][0]).toMatchObject({
      passthrough: false,
      translate: true,
      subtitle: true,
    })
  })
})
