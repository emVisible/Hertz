/**
 * CodeMirror 6 的 React 封装（Phase 4）。
 *
 * 为什么自己封而不是用 @uiw/react-codemirror：联动的另一半在**外面**——
 * 光标行要喂给画布高亮、大纲点击要驱动选区、拖分栏要拿到视口高度。
 * 这些都要 `EditorView` 实例，wrapper 库只会把它们藏进 ref 里再加一层版本对齐。
 * 6 个官方包已足够，直接用。
 *
 * 两条工程约定：
 * 1. **受控值只在外部值 ≠ 编辑器当前值时写回**。否则每敲一个字外部 setState →
 *    写回 → 重置选区，光标会往前跳——这是接 CM 最常踩的坑。
 * 2. **挂载失败要看得见**：CM 在 jsdom 下可能因为缺测量 API 抛错，这时降级成
 *    textarea 并置 `onError`，界面上给出提示而不是一片空白（空白会被当成"编辑器没了"）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { searchKeymap, highlightSelectionMatches, openSearchPanel } from '@codemirror/search'
import { markdown } from '@codemirror/lang-markdown'
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'

export interface MarkdownEditorHandle {
  /** 跳到某一行（大纲点击用），并把光标放到行首 */
  jumpToLine: (line: number) => void
  /**
   * 选中一段行区间（画布点段落 → 编辑器定位用）。
   * 两端都是 **0 基闭区间**行号——`[2,3]` 这种 mdcore 行区间的排他右端要在
   * 调用处减 1，转换只在这里做一次。
   */
  selectRange: (fromLine: number, toLine: number) => void
  view: () => EditorView | null
}

interface MarkdownEditorProps {
  value: string
  onChange: (next: string) => void
  /** 光标行变化（0 起）：喂给画布做联动高亮 */
  onCursorLine?: (line: number) => void
  /** 编辑器获得焦点（大纲 hover 时该亮对应的块） */
  onFocusChange?: (focused: boolean) => void
  placeholder?: string
  className?: string
  /** 降级成 textarea 时的回调（测试与异常兜底用） */
  onError?: (message: string) => void
  handleRef?: { current: MarkdownEditorHandle | null }
}

/** 主题：跟项目现有的 CSS 变量走，不另立一套配色 */
const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'transparent', color: 'inherit', fontSize: '12px' },
  '.cm-scroller': {
    fontFamily: "'SFMono-Regular', Consolas, Menlo, 'Courier New', monospace",
    lineHeight: '1.7',
    padding: '4px 0',
  },
  '.cm-content': { caretColor: 'var(--hz-primary)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-gutters': { backgroundColor: 'transparent', border: 'none', color: 'var(--hz-text-disabled)' },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--hz-text-secondary)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--hz-primary) !important' },
  '.cm-searchMatch': { backgroundColor: 'rgba(127, 127, 127, 0.25)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'rgba(127, 127, 127, 0.45)' },
  '.cm-panels': { backgroundColor: 'var(--hz-surface-2)', color: 'inherit' },
  '.cm-panels input, .cm-panels button': {
    backgroundColor: 'var(--hz-surface-1)',
    color: 'inherit',
    border: '1px solid var(--hz-border)',
    borderRadius: '4px',
    padding: '2px 6px',
  },
})

export function MarkdownEditor({
  value,
  onChange,
  onCursorLine,
  onFocusChange,
  placeholder,
  className,
  onError,
  handleRef,
}: MarkdownEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

  // 回调进 ref：扩展只在挂载时建一次，闭包里的回调不该是陈的
  const onChangeRef = useRef(onChange)
  const onCursorLineRef = useRef(onCursorLine)
  const onFocusChangeRef = useRef(onFocusChange)
  onChangeRef.current = onChange
  onCursorLineRef.current = onCursorLine
  onFocusChangeRef.current = onFocusChange

  const extensions = useMemo<Extension[]>(
    () => [
      history(),
      lineNumbers(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      markdown(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      EditorView.lineWrapping,
      keymap.of([
        { key: 'Mod-f', run: (view) => (openSearchPanel(view), true) },
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        indentWithTab,
      ]),
      theme,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onChangeRef.current(update.state.doc.toString())
        if (update.selectionSet || update.docChanged) {
          const head = update.state.selection.main.head
          onCursorLineRef.current?.(update.state.doc.lineAt(head).number - 1)
        }
      }),
      EditorView.contentAttributes.of({
        ...(placeholder ? { 'aria-placeholder': placeholder } : {}),
        'data-testid': 'mdstudio-cm-content',
      }),
    ],
    [placeholder],
  )

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let view: EditorView
    try {
      view = new EditorView({
        state: EditorState.create({ doc: value, extensions }),
        parent: host,
      })
    } catch (err) {
      // 降级必须**响亮**：静默换 textarea 会让人以为编辑器还在
      const message = err instanceof Error ? err.message : String(err)
      setFailed(message)
      onError?.(message)
      return
    }
    viewRef.current = view
    const focusHandler = () => onFocusChangeRef.current?.(true)
    const blurHandler = () => onFocusChangeRef.current?.(false)
    view.dom.addEventListener('focus', focusHandler)
    view.dom.addEventListener('blur', blurHandler)
    if (handleRef) {
      handleRef.current = {
        jumpToLine: (line: number) => {
          const doc = view.state.doc
          const clamped = Math.max(1, Math.min(line + 1, doc.lines))
          const pos = doc.line(clamped).from
          view.dispatch({
            selection: { anchor: pos },
            effects: EditorView.scrollIntoView(pos, { y: 'center' }),
          })
          view.focus()
        },
        selectRange: (fromLine: number, toLine: number) => {
          const doc = view.state.doc
          const lo = Math.max(1, Math.min(fromLine + 1, doc.lines))
          const hi = Math.max(lo, Math.min(toLine + 1, doc.lines))
          const a = doc.line(lo).from
          const b = doc.line(hi).to
          view.dispatch({
            selection: { anchor: a, head: b },
            effects: EditorView.scrollIntoView(a, { y: 'center' }),
          })
          view.focus()
        },
        view: () => viewRef.current,
      }
    }
    return () => {
      view.dom.removeEventListener('focus', focusHandler)
      view.dom.removeEventListener('blur', blurHandler)
      view.destroy()
      viewRef.current = null
      if (handleRef) handleRef.current = null
    }
    // 只在挂载时建一次：value 的同步走下面的 effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 受控值同步：只在真的不同才写回（否则光标会被拽回去）
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current === value) return
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
      selection: { anchor: Math.min(view.state.selection.main.anchor, value.length) },
    })
  }, [value])

  if (failed) {
    return (
      <div className={className} data-testid="mdstudio-editor-fallback">
        <div className="border-b border-warning/40 bg-warning/10 px-2 py-1 text-[11px] text-warning">
          编辑器加载失败，已降级为纯文本框：{failed}
        </div>
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          placeholder={placeholder}
          className="min-h-0 flex-1 resize-none bg-transparent px-3 py-2 font-mono text-xs leading-relaxed text-text-primary outline-none"
        />
      </div>
    )
  }

  return <div ref={hostRef} className={className} data-testid="mdstudio-editor" />
}