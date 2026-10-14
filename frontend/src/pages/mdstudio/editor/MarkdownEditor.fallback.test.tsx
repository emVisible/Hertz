/**
 * 降级路径的判据：CodeMirror 挂载失败时必须**看得见**地降级（Phase 4）。
 *
 * 单独一个文件，因为要用 vi.mock 换掉 `@codemirror/view` 的 EditorView 构造器：
 * ESM 命名空间不可 spy（`Cannot redefine property: EditorView`），而 vi.mock 是
 * 文件级的。顺带一个教训：别去 document.createElement 上打桩——那会把 React 自己
 * 的 DOM 操作一起炸掉，报错从"降级路径没走到"变成"测试环境坏了"，白查一场。
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@codemirror/view', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    // 用 Proxy 而不是替身类：扩展是在**渲染期**取的（EditorView.theme /
    // EditorView.updateListener…），替身类会把这些静态成员弄成 undefined，报错
    // 停在跟降级毫无关系的行上。只有 construct 被换成抛错。
    EditorView: new Proxy(actual.EditorView as object, {
      construct() {
        throw new Error('boom')
      },
    }),
  }
})

import { MarkdownEditor } from './MarkdownEditor'

describe('编辑器降级', () => {
  it('CM 挂载失败时降级成 textarea 并报出原因（不能静默）', () => {
    const onError = vi.fn()
    render(<MarkdownEditor value="# 标题" onChange={() => {}} className="h-full" onError={onError} />)
    expect(screen.getByTestId('mdstudio-editor-fallback')).toBeTruthy()
    expect(screen.getByText(/编辑器加载失败/)).toBeTruthy()
    expect(onError).toHaveBeenCalledWith('boom')
  })

  it('降级不是死路：textarea 还能改稿', () => {
    const onChange = vi.fn()
    render(<MarkdownEditor value="# 标题" onChange={onChange} className="h-full" />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '# 改过了' } })
    expect(onChange).toHaveBeenCalledWith('# 改过了')
  })
})
