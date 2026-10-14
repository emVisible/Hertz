/** CodeMirror 封装的判据（Phase 4）。
 *
 * 这份测试跑在 jsdom 里。CodeMirror 6 在 jsdom 下**能挂载**（它缺的是测量精度，
 * 不是 DOM 能力），所以这里可以真的断言 `.cm-editor` 出现了——而不是像对待
 * "需要真实布局"的组件那样跳过。两件要紧的事：
 *
 * 1. 挂载失败必须**降级且可见**（否则用户看到一片空白，以为编辑器没了）；
 * 2. 受控值同步不能拽光标：外部改文档时，只动内容不动选区末尾。
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { language } from '@codemirror/language'

import { MarkdownEditor, type MarkdownEditorHandle } from './MarkdownEditor'

function setup(props: Partial<React.ComponentProps<typeof MarkdownEditor>> = {}) {
  const onChange = vi.fn()
  const handleRef = { current: null as MarkdownEditorHandle | null }
  function Harness({ initial = '# 标题\n\n正文一段。\n', ...rest }: { initial?: string } & Partial<React.ComponentProps<typeof MarkdownEditor>>) {
    const [value, setValue] = useStateSafe(initial)
    return (
      <MarkdownEditor
        value={value}
        onChange={(next) => {
          onChange(next)
          setValue(next)
        }}
        handleRef={handleRef}
        {...rest}
      />
    )
  }
  const utils = render(<Harness {...props} />)
  return { ...utils, onChange, handleRef }
}

// 小工具：受控值，避免每写一个测试都写一遍 useState
import { useState } from 'react'
function useStateSafe(initial: string): [string, (v: string) => void] {
  return useState(initial)
}

describe('挂载', () => {
  it('渲染出真正的 CodeMirror 编辑面（有行号槽与 content）', () => {
    setup()
    expect(screen.getByTestId('mdstudio-editor')).toBeTruthy()
    const content = document.querySelector('.cm-content')
    expect(content).toBeTruthy()
    expect(document.querySelector('.cm-lineNumbers')).toBeTruthy()
    // 文档真的进了编辑器（不是渲染了个空壳）
    expect(document.querySelector('.cm-content')?.textContent).toContain('正文一段。')
  })

  it('markdown 语言是装上的（facet 里有 language 插件，不是纯文本编辑器）', () => {
    const { handleRef } = setup()
    const view = handleRef.current?.view()
    expect(view?.state.facet(language)).toBeTruthy()
  })

  it('外部值能同步进来（切稿时不丢内容）', () => {
    function Harness() {
      const [value, setValue] = useState('# 标题\n')
      return (
        <>
          <button type="button" onClick={() => setValue('# 换了一篇\n\n新内容。\n')}>
            换稿
          </button>
          <MarkdownEditor value={value} onChange={setValue} />
        </>
      )
    }
    render(<Harness />)
    act(() => {
      fireEvent.click(screen.getByText('换稿'))
    })
    expect(document.querySelector('.cm-content')?.textContent).toContain('换了一篇')
  })
})

describe('联动句柄', () => {
  it('大纲点击：跳到指定行并把光标放在行首', () => {
    const { handleRef } = setup()
    handleRef.current?.jumpToLine(2)
    const view = handleRef.current?.view()
    expect(view).toBeTruthy()
    const head = view!.state.selection.main.head
    expect(view!.state.doc.lineAt(head).number).toBe(3)
    expect(head).toBe(view!.state.doc.line(3).from)
  })

  it('跳到越界的行会夹住（大纲数据脏了不该抛）', () => {
    const { handleRef } = setup()
    expect(() => handleRef.current?.jumpToLine(9999)).not.toThrow()
    expect(() => handleRef.current?.jumpToLine(-5)).not.toThrow()
    const view = handleRef.current!.view()!
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(1)
  })

  it('选中行区间（画布点段落 → 编辑器定位），两端是 0 基闭区间', () => {
    const { handleRef } = setup()
    handleRef.current?.selectRange(2, 2)
    const view = handleRef.current!.view()!
    const sel = view.state.selection.main
    expect(view.state.doc.lineAt(sel.from).number).toBe(3)
    expect(view.state.doc.lineAt(sel.to).number).toBe(3)
  })

  it('卸载时把句柄清空（不留一个指向已销毁视图的引用）', () => {
    const { handleRef, unmount } = setup()
    expect(handleRef.current).toBeTruthy()
    unmount()
    expect(handleRef.current).toBeNull()
  })
})
