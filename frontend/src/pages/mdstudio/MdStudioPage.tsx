/** MD Studio 顶页：图文工坊三栏工作站（设计 §5）。
 *
 * 编排：排版稿 CRUD（react-query）+ 本地 draft（自动保存 800ms debounce PUT）
 * + 画布重排（150ms debounce）+ 平台导出动作 + 画布内联编辑 + 批量出图队列。
 * 持久化字段映射：footer（小红书署名）、breaks（手动分页边界）与 qr 一起存在 cover
 * JSON 里——cover 是自由 JSON 槽（§6 模型预留位），加键不需要迁移。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  applyTheme,
  copyForWechat,
  copyForZhihu,
  defaultThemeFor,
  exportZip,
  parseToIR,
  parseToIRDetailed,
  renderLongImage,
  xhsCaption,
  xhsCards,
  XHS_RATIO_KEYS,
  getTheme,
  type ThemeOverrides,
  type XhsRatio,
} from '@hertz/mdcore'

import { layoutApi, type LayoutDoc, type LayoutPlatform } from '../../api'
import { Button, EmptyState, Icon, Input, Select, ToggleChip, useToast } from '../../components/ui'
import { BatchExportModal, type BatchTarget } from './BatchExportModal'
import { CanvasPanel, type CanvasBlockTarget, type XhsRenderInfo } from './CanvasPanel'
import {
  canRedo,
  canUndo,
  createHistory,
  currentOf,
  pushState,
  redo,
  undo,
  type DraftHistory,
} from './draftHistory'
import { MarkdownEditor, type MarkdownEditorHandle } from './editor/MarkdownEditor'
import { OutlinePanel } from './editor/OutlinePanel'
import { blockIndexAtLine, buildOutline, type OutlineItem } from './editor/outline'
import { InspectorPanel, type ExportAction } from './InspectorPanel'
import { LayoutListPanel } from './LayoutListPanel'
import { downloadBlob } from './shared'

/** 自动保存 debounce（顶栏状态点：未保存/保存中/已保存） */
const SAVE_DEBOUNCE_MS = 800
/** 画布重排 debounce（§2 性能预算） */
const RENDER_DEBOUNCE_MS = 150

interface DraftState {
  title: string
  source_md: string
  platform: LayoutPlatform
  theme_id: string
  overrides: ThemeOverrides
  footer: string
  qr: string | null
  /** 手动拖过的分页边界（IR 块序号），小红书卡片分页专用 */
  breaks: number[]
  /** 小红书卡片比例与封面/页眉字段（切片 4，全部存在 cover JSON 槽） */
  ratio: XhsRatio
  coverSub: string
  coverBadge: string
  pageNum: boolean
  header: string
  /** 卡片底纹与装饰件（切片 5，存在 cover JSON 槽） */
  texture: string
  deco: string
  /**
   * **按栏目各存一份**的样式配置与主题（切片 10，存在 cover JSON 槽）。
   *
   * 为什么必须分栏存：`overrides` 早先是一个跨栏目共用的袋子，于是小红书上调过的
   * 字号 36px、主色、投影，原封不动跟着进知乎——690 宽的文章用 36px 正文，
   * 标题撑成两行、表格挤成竖条。用户看到的「部分 md 渲染不完全 + 样式污染」，
   * 根子上就是这一个袋子。现在切走时把当前这份存进 `platform_overrides`，
   * 切回来时取回，没去过的栏目用该栏默认主题 + 空配置。
   */
  platformOverrides: Record<string, ThemeOverrides>
  platformThemes: Record<string, string>
}

type SaveState = 'saved' | 'dirty' | 'saving'

/** 小红书卡片比例（切片 4）。存 cover JSON 槽，加键不需要迁移。 */
function ratioOf(cover: Record<string, unknown> | undefined): XhsRatio {
  const raw = cover?.ratio;
  return typeof raw === 'string' && (XHS_RATIO_KEYS as string[]).includes(raw) ? (raw as XhsRatio) : '3:4';
}
function strOf(cover: Record<string, unknown> | undefined, key: string): string {
  return typeof cover?.[key] === 'string' ? (cover[key] as string) : '';
}
function boolOf(cover: Record<string, unknown> | undefined, key: string, fallback: boolean): boolean {
  return typeof cover?.[key] === 'boolean' ? (cover[key] as boolean) : fallback;
}

/** cover.platform_overrides：按栏目存的 overrides 袋，读不出就当空的 */
function mapOf(raw: unknown): Record<string, ThemeOverrides> {
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, ThemeOverrides> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = v as ThemeOverrides
  }
  return out
}
/** cover.platform_themes：按栏目存的主题 id */
function strMapOf(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' && v) out[k] = v
  }
  return out
}
/** 主题是不是属于这个平台——右栏本来就只列本平台主题，缓存里那份也得守同一条 */
function isPlatformTheme(themeId: string, platform: LayoutPlatform): boolean {
  try {
    return getTheme(themeId).platform === platform
  } catch {
    return false
  }
}
function breaksOf(cover: Record<string, unknown> | undefined): number[] {
  const raw = cover?.breaks
  return Array.isArray(raw) ? raw.filter((n): n is number => Number.isInteger(n) && n > 0) : []
}

function draftFromDoc(doc: LayoutDoc): DraftState {
  return {
    title: doc.title,
    source_md: doc.source_md,
    platform: doc.platform,
    theme_id: doc.theme_id || defaultThemeFor(doc.platform).id,
    overrides: doc.overrides as ThemeOverrides,
    // footer / breaks / qr / ratio / 封面字段 存 cover JSON 槽（封面/品牌位，§6 模型预留位）
    footer: strOf(doc.cover, 'footer'),
    qr: typeof doc.cover?.qr === 'string' ? doc.cover.qr : null,
    breaks: breaksOf(doc.cover),
    ratio: ratioOf(doc.cover),
    coverSub: strOf(doc.cover, 'cover_sub'),
    coverBadge: strOf(doc.cover, 'cover_badge'),
    pageNum: boolOf(doc.cover, 'page_num', true),
    header: strOf(doc.cover, 'header'),
    texture: strOf(doc.cover, 'texture'),
    deco: strOf(doc.cover, 'deco'),
    platformOverrides: mapOf(doc.cover?.platform_overrides),
    platformThemes: strMapOf(doc.cover?.platform_themes),
  }
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return debounced
}

export function MdStudioPage() {
  const { t } = useTranslation()
  const toast = useToast()
  const queryClient = useQueryClient()

  const listQuery = useQuery({ queryKey: ['layout-list'], queryFn: layoutApi.list })
  const layouts = useMemo(() => listQuery.data ?? [], [listQuery.data])

  const [selectedId, setSelectedId] = useState<string | null>(null)
  // 列表到达后默认选中最新那份（updated_at 倒序的第一个）
  useEffect(() => {
    if (selectedId === null && layouts.length > 0) setSelectedId(layouts[0].id)
  }, [layouts, selectedId])

  const docQuery = useQuery({
    queryKey: ['layout', selectedId],
    queryFn: () => layoutApi.get(selectedId!),
    enabled: selectedId !== null,
  })

  const [draft, setDraft] = useState<DraftState | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [exporting, setExporting] = useState<ExportAction | null>(null)
  /**
   * 文档级撤销/重做（W2）：只管**非文字**变更（主题/平台/字号/封面/比例/分页边界）。
   * 文字归 CodeMirror——两边都管会打架，用户按一次撤销会退两段历史。
   */
  const [history, setHistory] = useState<DraftHistory<DraftState>>(() => createHistory<DraftState>({
    title: '', source_md: '', platform: 'wechat', theme_id: '', overrides: {},
    footer: '', qr: null, breaks: [], ratio: '3:4', coverSub: '', coverBadge: '',
    pageNum: true, header: '', texture: '', deco: '',
    platformOverrides: {}, platformThemes: {},
  }))
  const [zoom, setZoom] = useState(1)
  const [dark, setDark] = useState(false)
  const [xhsInfo, setXhsInfo] = useState<XhsRenderInfo>({ pageCount: 0, overflow: false })
  /** 画布内联编辑：正在改的块（点段落进来）与其 markdown 文本 */
  const [editing, setEditing] = useState<CanvasBlockTarget | null>(null)
  /** 编辑器 ↔ 画布 联动（Phase 4） */
  const editorRef = useRef<MarkdownEditorHandle | null>(null)
  const [outlineOpen, setOutlineOpen] = useState(true)
  const [cursorLine, setCursorLine] = useState(0)
  /** 小红书卡片当前展示页（0 = 封面） */
  const [xhsPage, setXhsPage] = useState(0)
  /** 画布高亮的块序号：由光标行换算，null = 不高亮 */
  const [focusBlock, setFocusBlock] = useState<number | null>(null)
  /** 左栏宽度（拖分栏），localStorage 记住 */
  const [leftWidth, setLeftWidth] = useState(() => Number(localStorage.getItem('hertz.mdstudio.leftWidth')) || 320)
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const [editText, setEditText] = useState('')
  /** 批量出图：勾选集 + 队列弹层 */
  const [batchMode, setBatchMode] = useState(false)
  const [batchIds, setBatchIds] = useState<string[]>([])
  const [batchOpen, setBatchOpen] = useState(false)

  const mountRef = useRef<HTMLDivElement | null>(null)
  // 自动保存计时器与「载入中文档」的去抖守卫
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loadedDocRef = useRef<LayoutDoc | null>(null)

  // 单稿到达 → 载入 draft（只在换稿时重置，保存回流的同稿不覆盖正在编辑的内容）
  useEffect(() => {
    const doc = docQuery.data
    if (!doc || doc.id !== selectedId) return
    if (loadedDocRef.current?.id === doc.id) return
    loadedDocRef.current = doc
    const loaded = draftFromDoc(doc)
    setDraft(loaded)
    // 历史栈随稿件重置（W2）：撤销的起点必须是"这篇稿刚打开的样子"，
    // 否则第一次撤销会把稿子退成加载前的占位状态（主题空、平台错）。
    setHistory(createHistory(loaded))
    setSaveState('saved')
  }, [docQuery.data, selectedId])

  /**
   * 改稿的统一入口。
   *
   * 除了写进 draft，它还**记一笔文档级历史**（W2）：CodeMirror 的撤销只管文字，
   * 而拖一个主题/字号滑杆同样把稿子改了，而 `Ctrl+Z` 撤不回来——用户于是
   * 养成"不敢动样式"的习惯，那等于产品没做。
   *
   * `text` 的变更**不入栈**：CodeMirror 已经管着文字撤销了，两边都管会打架
   * （用户按一次撤销，文字退了、样式也退了，变成两段历史）。
   */
  const undoDoc = useCallback(() => {
    setHistory((h) => {
      const next = undo(h);
      const target = currentOf(next);
      if (target) setDraft(target);
      return next;
    });
    setSaveState('dirty');
  }, []);

  const redoDoc = useCallback(() => {
    setHistory((h) => {
      const next = redo(h);
      const target = currentOf(next);
      if (target) setDraft(target);
      return next;
    });
    setSaveState('dirty');
  }, []);

  const patchDraft = useCallback((patch: Partial<DraftState>, opts: { history?: boolean } = {}) => {
    const keys = Object.keys(patch);
    const withText = keys.includes('source_md');
    const record = opts.history ?? !withText;
    setDraft((prev) => {
      if (!prev) return prev
      const next = { ...prev, ...patch };
      if (record) {
        setHistory((h) => pushState(h, next, keys));
        loadedDocRef.current = null; // 别让"未落库的 doc"把新状态盖回去
      }
      return next;
    });
    setSaveState('dirty');
  }, [])

  // 自动保存：draft 变更 800ms debounce PUT 全稿字段
  useEffect(() => {
    if (!draft || !selectedId || saveState !== 'dirty') return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    const snapshot = draft
    saveTimer.current = setTimeout(() => {
      setSaveState('saving')
      layoutApi
        .update(selectedId, {
          title: snapshot.title,
          source_md: snapshot.source_md,
          platform: snapshot.platform,
          theme_id: snapshot.theme_id,
          overrides: snapshot.overrides,
          cover: {
            footer: snapshot.footer,
            qr: snapshot.qr,
            breaks: snapshot.breaks,
            ratio: snapshot.ratio,
            cover_sub: snapshot.coverSub,
            cover_badge: snapshot.coverBadge,
            page_num: snapshot.pageNum,
            header: snapshot.header,
            texture: snapshot.texture,
            deco: snapshot.deco,
            // 按栏目缓存跟着落库：只存内存的话一刷新就没了，那不叫缓存
            platform_overrides: snapshot.platformOverrides,
            platform_themes: snapshot.platformThemes,
          },
        })
        .then((doc) => {
          loadedDocRef.current = doc
          setSaveState((s) => (s === 'saving' ? 'saved' : s))
          void queryClient.invalidateQueries({ queryKey: ['layout-list'] })
        })
        .catch(() => {
          setSaveState('dirty')
          toast(t('mdstudio.save.failed'), 'error')
        })
    }, SAVE_DEBOUNCE_MS)
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [draft, saveState, selectedId, queryClient, t, toast])

  // 画布输入 150ms debounce（改 overrides/源文时避免每次按键都重排）
  const renderDraft = useDebounced(draft, RENDER_DEBOUNCE_MS)

  /**
   * 大纲与联动都从**已解析的 IR** 取，不重扫 Markdown：行号在 IR 里已经是解析产物，
   * 再扫一遍就有了第二套行号，两套迟早漂（表现为"点标题跳到隔壁段落"）。
   */
  /** 最新 IR 的 ref：给身份必须稳定的回调读（见 handleCursorLine） */
  const parsedRef = useRef<ReturnType<typeof parseToIRDetailed> | null>(null)

  /**
   * **全页唯一的 IR**（W0：一次解析多处复用）。
   *
   * 早先大纲、光标反查、画布渲染各自调 `parseToIR`：万字稿单次解析约 15ms，
   * 一段输入下来是三段叠加。而光标那条还挂在 `setFocusBlock` 的 updater 里——
   * updater 必须是纯函数，于是每按一键都**同步**跑一遍全篇解析，150ms 防抖形同虚设。
   *
   * 现在解析只在这里发生一次，下游（大纲 / 画布 / 光标反查 / 导出）都从这一份读。
   * 解析失败不兜底成空数组：那会让画布变成"看着正常其实没渲染"，比报错更难查。
   */
  const parsed = useMemo(() => {
    if (!renderDraft?.source_md) return null
    try {
      return parseToIRDetailed(renderDraft.source_md)
    } catch {
      return null
    }
  }, [renderDraft?.source_md])

  parsedRef.current = parsed

  const outline: OutlineItem[] = useMemo(
    () => (parsed ? buildOutline(parsed.blocks) : []),
    [parsed],
  )

  const activeHeading = useMemo(() => {
    let best: OutlineItem | null = null
    for (const item of outline) {
      if (item.line <= cursorLine) best = item
      else break
    }
    return best
  }, [outline, cursorLine])

  /**
   * 光标行 → 画布该高亮哪一块。
   *
   * 两个要点：
   * ①**依赖数组为空**——身份必须稳定。早先它的依赖是 `source_md`，于是每次按键都换
   *    一个新函数，而 `CanvasPanel` 的渲染 effect 把 `onBlockClick` 放在依赖里，
   *    结果**每按一键就重排 + 重新分页一次**（防抖只挡文本，挡不住回调身份变化）。
   * ②**不在 setState 的 updater 里做解析**——updater 必须纯，StrictMode 下会跑两次，
   *    于是"一次按键两次解析"。最新 IR 走 ref 读。
   */
  const handleCursorLine = useCallback((line: number) => {
    setCursorLine(line)
    const ir = parsedRef.current
    if (!ir) {
      setFocusBlock(null)
      return
    }
    const next = blockIndexAtLine(ir.blocks, line)
    setFocusBlock((prev) => (next === prev ? prev : next))
  }, [])

  /** 拖分栏：pointer 事件跟着窗口走，鼠标移出侧栏也不断 */
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current
      if (!drag) return
      const next = Math.max(240, Math.min(640, drag.startWidth + (e.clientX - drag.startX)))
      setLeftWidth(next)
    }
    const onUp = () => {
      if (!dragRef.current) return
      dragRef.current = null
      localStorage.setItem('hertz.mdstudio.leftWidth', String(leftWidth))
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [leftWidth])

  const handleXhsInfo = useCallback((info: XhsRenderInfo) => {
    setXhsInfo((prev) =>
      prev.pageCount === info.pageCount && prev.overflow === info.overflow ? prev : info,
    )
  }, [])

  /** 拖动分页边界 → 写回 draft（自动保存接管落库） */
  const handleBreaksChange = useCallback(
    (breaks: number[]) => {
      patchDraft({ breaks })
    },
    [patchDraft],
  )

  /** 画布点段落：取出该块的源码行段进编辑器（markdown 仍是唯一真相源，不做 IR 反序列化） */
  const draftRef = useRef(draft)
  draftRef.current = draft

  const handleBlockClick = useCallback(
    (target: CanvasBlockTarget) => {
      const draft = draftRef.current
      if (!draft) return
      if (!target.line) {
        toast(t('mdstudio.edit.noLine'), 'warning')
        return
      }
      const lines = draft.source_md.split('\n')
      setEditing(target)
      setEditText(lines.slice(target.line[0], target.line[1]).join('\n'))
      // 编辑器同步定位到这一段（CodeMirror 的选区 + 滚动，居中在视线里）
      editorRef.current?.selectRange(target.line[0], Math.max(target.line[0], target.line[1] - 1))
    },
    // 依赖里不能有 `draft`：它每次输入都换对象，而这个回调进了 CanvasPanel 的
    // 渲染 effect 依赖——于是**每按一键就整篇重排 + 重新分页**，
    // 150ms 防抖只挡文本，挡不住回调身份变化。最新 draft 走 ref 读。
    [t, toast],
  )

  /** 保存块编辑：按行区间回写 source_md；其余行的行号随后由重新解析自然对齐 */
  const commitBlockEdit = () => {
    if (!draft || !editing?.line) return
    const [from, to] = editing.line
    const lines = draft.source_md.split('\n')
    const next = [...lines.slice(0, from), ...editText.split('\n'), ...lines.slice(to)]
    patchDraft({ source_md: next.join('\n') })
    setEditing(null)
  }

  const toggleBatchId = (id: string) =>
    setBatchIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))

  const toggleBatchAll = () => {
    const all = layouts.map((l) => l.id)
    setBatchIds((prev) => (prev.length === all.length ? [] : all))
  }

  const batchTargets: BatchTarget[] = useMemo(
    () =>
      batchIds
        .map((id) => layouts.find((l) => l.id === id))
        .filter((l): l is NonNullable<typeof l> => !!l)
        .map((l) => ({ id: l.id, title: l.title, platform: l.platform })),
    [batchIds, layouts],
  )

  const invalidateList = () => queryClient.invalidateQueries({ queryKey: ['layout-list'] })

  const createLayout = async (init?: { title?: string; source_md?: string; source_ref?: string | null }) => {
    try {
      const doc = await layoutApi.create({
        title: init?.title ?? '',
        source_md: init?.source_md ?? '',
        source_ref: init?.source_ref ?? null,
        platform: 'wechat',
        theme_id: defaultThemeFor('wechat').id,
      })
      loadedDocRef.current = null
      await invalidateList()
      setSelectedId(doc.id)
      const created = draftFromDoc(doc)
      setDraft(created)
      setHistory(createHistory(created))
      loadedDocRef.current = doc
      toast(t('mdstudio.created'), 'success')
    } catch {
      toast(t('mdstudio.actionFailed'), 'error')
    }
  }

  const importDocs = async (path: string) => {
    try {
      const res = await layoutApi.importDocs(path)
      await createLayout({ title: res.suggested_title, source_md: res.content, source_ref: path })
    } catch {
      toast(t('mdstudio.actionFailed'), 'error')
    }
  }

  const importStudio = async (run: string) => {
    try {
      const res = await layoutApi.importStudio(run)
      await createLayout({ title: res.suggested_title, source_md: res.content, source_ref: `studio:${run}` })
    } catch {
      toast(t('mdstudio.actionFailed'), 'error')
    }
  }

  const deleteLayout = async (id: string) => {
    try {
      await layoutApi.remove(id)
      if (selectedId === id) {
        loadedDocRef.current = null
        setDraft(null)
        setSelectedId(layouts.find((l) => l.id !== id)?.id ?? null)
      }
      await invalidateList()
      toast(t('mdstudio.deleted'), 'success')
    } catch {
      toast(t('mdstudio.actionFailed'), 'error')
    }
  }

  /** 换页后立刻回到封面：稿子换语言/换比例之后，旧页码多半已无意义 */
  const handleXhsPageChange = useCallback((index: number) => {
    setXhsPage(index)
  }, [])

  /**
   * 切栏目：先把当前这份配置存进它自己的格子，再换上目标栏目的那份。
   *
   * 早先这里只改 `platform` + `theme_id`，`overrides` 原样带着走——于是小红书的
   * 36px 字号进知乎，标题直接撑成两行。**换平台而不换配置，等于只换了个标签。**
   */
  const changePlatform = (p: LayoutPlatform) => {
    if (!draft || draft.platform === p) return
    const platformOverrides = {
      ...draft.platformOverrides,
      [draft.platform]: draft.overrides,
    }
    const platformThemes = { ...draft.platformThemes, [draft.platform]: draft.theme_id }
    // 去过的栏目取回自己那份；没去过的用该栏默认主题 + 空配置
    const saved = platformOverrides[p]
    const theme = platformThemes[p] ?? defaultThemeFor(p).id
    patchDraft({
      platform: p,
      platformOverrides,
      platformThemes,
      overrides: saved ? { ...saved } : {},
      // 主题必须属于目标平台：拿小红书主题去渲染知乎文章，换平台就等于没换
      theme_id: isPlatformTheme(theme, p) ? theme : defaultThemeFor(p).id,
    })
  }

  /** 导出：按 draft 同参数离屏重建渲染态 DOM（画布带预览缩放/深色滤镜，不直接导出） */
  const runExport = async (action: ExportAction) => {
    if (!draft || exporting) return
    setExporting(action)
    try {
      const ir = parseToIR(draft.source_md)
      const name = draft.title || t('mdstudio.untitled')
      if (action === 'copy-wechat') {
        await copyForWechat(ir, draft.theme_id, draft.overrides)
        toast(t('mdstudio.export.copiedWechat'), 'success')
      } else if (action === 'copy-zhihu') {
        await copyForZhihu(ir, draft.theme_id, draft.overrides)
        toast(t('mdstudio.export.copiedZhihu'), 'success')
      } else if (action === 'copy-caption') {
        await navigator.clipboard.writeText(xhsCaption(ir))
        toast(t('mdstudio.export.copiedCaption'), 'success')
      } else if (action === 'zip') {
        const res = xhsCards(ir, {
          theme: draft.theme_id,
          overrides: draft.overrides,
          footer: draft.footer,
          qr: draft.qr,
          breaks: draft.breaks,
          ratio: draft.ratio,
          header: draft.header,
          pageNum: draft.pageNum,
          coverSubtitle: draft.coverSub,
          coverBadge: draft.coverBadge,
          cardTexture: draft.texture || undefined,
          cardDecoPreset: draft.deco || undefined,
        })
        const blob = await exportZip(res.pages)
        downloadBlob(blob, `${name}-xhs.zip`)
        toast(t('mdstudio.export.done'), 'success')
      } else {
        // 长图全平台通用：applyTheme 渲染态 → 切片长图
        const el = applyTheme(ir, draft.theme_id, draft.overrides)
        el.style.width = draft.platform === 'zhihu' ? '690px' : '375px'
        el.style.boxSizing = 'border-box'
        document.body.appendChild(el)
        try {
          const blob = await renderLongImage(el)
          downloadBlob(blob, `${name}.png`)
          toast(t('mdstudio.export.done'), 'success')
        } finally {
          el.remove()
        }
      }
    } catch (e) {
      // 带上原因：失焦、字体加载失败、画布超限是三种完全不同的下一步
      toast(`${t('mdstudio.export.failed')}：${(e as Error).message}`, 'error')
    } finally {
      setExporting(null)
    }
  }

  // 顶栏主导出按钮随平台变
  const primaryExport: { action: ExportAction; label: string } =
    draft?.platform === 'xhs'
      ? { action: 'zip', label: t('mdstudio.export.zip') }
      : draft?.platform === 'zhihu'
        ? { action: 'copy-zhihu', label: t('mdstudio.export.copyZhihu') }
        : { action: 'copy-wechat', label: t('mdstudio.export.copyWechat') }

  // 空态：无稿时整页出路，而不是三栏空壳
  if (listQuery.isSuccess && layouts.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState
          icon="briefs"
          title={t('mdstudio.empty.title')}
          description={t('mdstudio.empty.desc')}
          action={
            <Button icon={<Icon name="plus" size={14} />} onClick={() => void createLayout()}>
              {t('mdstudio.empty.create')}
            </Button>
          }
        />
      </div>
    )
  }

  const saveLabel =
    saveState === 'saving'
      ? t('mdstudio.save.saving')
      : saveState === 'dirty'
        ? t('mdstudio.save.dirty')
        : t('mdstudio.save.saved')

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="mdstudio-page">
      {/* 顶栏：稿名（行内改名）+ 保存状态 + 主导出 */}
      <div className="flex shrink-0 items-center gap-3 border-b border-border bg-surface-1 px-3 py-2">
        <Input
          aria-label={t('mdstudio.titleLabel')}
          value={draft?.title ?? ''}
          placeholder={t('mdstudio.untitled')}
          onChange={(e) => patchDraft({ title: e.target.value })}
          className="w-64"
        />
        <span className="flex items-center gap-1.5 text-xs text-text-secondary" data-testid="mdstudio-save-state">
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${
              saveState === 'saved' ? 'bg-success' : saveState === 'saving' ? 'animate-pulse bg-primary' : 'bg-warning'
            }`}
          />
          {saveLabel}
        </span>
        {/* 文档级撤销/重做（W2）：只管非文字变更（主题/平台/字号/封面/比例）。
            置灰时是真的撤不回去——不摆一个按下去没反应的按钮。 */}
        <div className="ml-2 flex items-center gap-1" data-testid="mdstudio-history">
          <Button
            size="sm"
            variant="ghost"
            disabled={!canUndo(history)}
            onClick={undoDoc}
            title={t('mdstudio.history.undo')}
            aria-label={t('mdstudio.history.undo')}
          >
            {t('mdstudio.history.undo')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!canRedo(history)}
            onClick={redoDoc}
            title={t('mdstudio.history.redo')}
            aria-label={t('mdstudio.history.redo')}
          >
            {t('mdstudio.history.redo')}
          </Button>
        </div>
        <div className="ml-auto">
          <Button
            size="sm"
            loading={exporting === primaryExport.action}
            disabled={exporting !== null || !draft}
            onClick={() => void runExport(primaryExport.action)}
          >
            {primaryExport.label}
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 overflow-x-auto">
        {/* 左栏：排版稿列表 + 导入 + 源文编辑（宽度可拖） */}
        <aside
          className="flex shrink-0 flex-col border-r border-border bg-surface-1"
          style={{ width: leftWidth }}
          data-testid="mdstudio-left"
        >
          <div className="min-h-0 flex-1">
            <LayoutListPanel
              layouts={listQuery.data}
              loading={listQuery.isLoading}
              selectedId={selectedId}
              onSelect={(id) => {
                loadedDocRef.current = null
                setDraft(null)
                setSelectedId(id)
              }}
              onCreate={(init) => void createLayout(init)}
              onImportDocs={(path) => void importDocs(path)}
              onImportStudio={(run) => void importStudio(run)}
              onDelete={(id) => void deleteLayout(id)}
              batchMode={batchMode}
              batchIds={batchIds}
              onBatchModeChange={setBatchMode}
              onToggleBatchId={toggleBatchId}
              onToggleBatchAll={toggleBatchAll}
              onBatchExport={() => setBatchOpen(true)}
            />
          </div>
          {/* 源文编辑：CodeMirror 6（Phase 4）。自带行号/搜索面板(Cmd+F)/撤销重做/
              Markdown 高亮/括号配对，文本控件该有的都补齐了 */}
          {draft && (
            <div className="flex h-[45%] shrink-0 flex-col border-t border-border">
              <div className="flex shrink-0 items-center gap-1.5 px-3 py-1.5">
                <Icon name="edit" size={12} className="text-text-secondary" />
                <span className="text-xs font-medium text-text-secondary">{t('mdstudio.source.title')}</span>
                <button
                  type="button"
                  aria-pressed={outlineOpen}
                  onClick={() => setOutlineOpen((v) => !v)}
                  data-testid="mdstudio-outline-toggle"
                  className={`rounded border px-1.5 py-0.5 text-[10px] transition-colors ${
                    outlineOpen
                      ? 'border-primary/50 bg-primary/10 text-primary'
                      : 'border-border text-text-secondary hover:text-text-primary'
                  }`}
                >
                  {t('mdstudio.outline.toggle')}
                </button>
                <span className="ml-auto text-[10px] text-text-disabled">
                  {t('briefs.charCount', { count: draft.source_md.length })}
                </span>
              </div>
              {outlineOpen && (
                <OutlinePanel
                  items={outline}
                  activeText={activeHeading?.text ?? null}
                  onPick={(item) => editorRef.current?.jumpToLine(item.line)}
                  onClose={() => setOutlineOpen(false)}
                />
              )}
              <div className="min-h-0 flex-1 px-1 pb-1">
                <MarkdownEditor
                  className="h-full"
                  value={draft.source_md}
                  onChange={(next) => patchDraft({ source_md: next })}
                  onCursorLine={handleCursorLine}
                  placeholder={t('mdstudio.source.placeholder')}
                  handleRef={editorRef}
                />
              </div>
            </div>
          )}
        </aside>

        {/* 分栏拖柄：按住改左栏宽度，松手记住 */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t('mdstudio.split.label')}
          tabIndex={0}
          data-testid="mdstudio-split"
          onPointerDown={(e) => {
            dragRef.current = { startX: e.clientX, startWidth: leftWidth }
            document.body.style.cursor = 'col-resize'
            document.body.style.userSelect = 'none'
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') setLeftWidth((w) => Math.max(240, w - 16))
            if (e.key === 'ArrowRight') setLeftWidth((w) => Math.min(640, w + 16))
          }}
          className="group relative w-1 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-primary/40"
        />

        {/* 中栏：平台感知画布 */}
        <section className="flex min-w-[360px] flex-1 flex-col">
          <div className="flex shrink-0 items-center gap-2 px-3 py-2">
            <Select
              aria-label={t('mdstudio.canvas.zoom')}
              value={String(zoom)}
              options={[
                { value: '0.5', label: '50%' },
                { value: '0.75', label: '75%' },
                { value: '1', label: '100%' },
              ]}
              onChange={(e) => setZoom(Number(e.target.value))}
              className="w-24"
            />
            {/* 深色预览：切到该平台真深色主题（晚风/夜航/墨案），只改预览不改稿 */}
            <ToggleChip active={dark} onClick={() => setDark((v) => !v)} title={t('mdstudio.canvas.dark')}>
              <Icon name="moon" size={11} /> {t('mdstudio.canvas.dark')}
            </ToggleChip>
            {/* 小红书翻页：单页展示之后必须给导航，否则只能看到封面那张 */}
            {renderDraft?.platform === 'xhs' && xhsInfo.pageCount > 1 && (
              <div className="ml-auto flex items-center gap-1" data-testid="mdstudio-xhs-pager">
                <button
                  type="button"
                  aria-label={t('mdstudio.xhs.prev')}
                  disabled={xhsPage <= 0}
                  onClick={() => setXhsPage((p) => Math.max(0, p - 1))}
                  className="flex h-7 w-7 items-center justify-center rounded border border-border text-text-secondary transition-colors enabled:hover:border-primary enabled:hover:text-primary disabled:opacity-40"
                >
                  <Icon name="close" size={10} className="rotate-45" />
                </button>
                <span className="min-w-16 text-center text-[11px] text-text-secondary">
                  {xhsPage === 0 ? t('mdstudio.xhs.cover') : t('mdstudio.xhs.page', { n: xhsPage })} /{' '}
                  {xhsInfo.pageCount - 1}
                </span>
                <button
                  type="button"
                  aria-label={t('mdstudio.xhs.next')}
                  disabled={xhsPage >= xhsInfo.pageCount - 1}
                  onClick={() => setXhsPage((p) => Math.min(xhsInfo.pageCount - 1, p + 1))}
                  className="flex h-7 w-7 items-center justify-center rounded border border-border text-text-secondary transition-colors enabled:hover:border-primary enabled:hover:text-primary disabled:opacity-40"
                >
                  <Icon name="close" size={10} className="-rotate-45" />
                </button>
              </div>
            )}
          </div>
          <div
            // 小红书只收窄留白（p-2）：卡片本身占了满屏宽，四周再垫 28px 纯浪费。
            // 微信/知乎是长文章页，留白是呼吸感，不动。
            data-mdstudio-canvas-viewport=""
            className={`min-h-0 flex-1 overflow-auto transition-colors duration-150 ${
              renderDraft?.platform === 'xhs' ? 'p-2' : 'p-4'
            } ${dark ? 'bg-[#14161c]' : ''}`}
          >
            <div
              className={`mx-auto w-fit rounded-lg border border-border shadow-md ${
                renderDraft?.platform === 'xhs' ? 'p-2' : 'p-3'
              } ${dark ? 'bg-[#1c1f28]' : 'bg-surface-1'}`}
            >
              {renderDraft && (
                <CanvasPanel
                  parsed={parsed}
                  platform={renderDraft.platform}
                  themeId={renderDraft.theme_id}
                  overrides={renderDraft.overrides}
                  footer={renderDraft.footer}
                  qr={renderDraft.qr}
                  breaks={renderDraft.breaks}
                  zoom={zoom}
                  dark={dark}
                  emptyHint={t('mdstudio.canvas.emptyHint')}
                  diagnosticsLabels={{
                    summary: t('mdstudio.canvas.diagnostics.summary'),
                    expand: t('mdstudio.canvas.diagnostics.expand'),
                    collapse: t('mdstudio.canvas.diagnostics.collapse'),
                    line: t('mdstudio.canvas.diagnostics.line'),
                    times: t('mdstudio.canvas.diagnostics.times'),
                  }}
                  mountRef={mountRef}
                  onXhsInfo={handleXhsInfo}
                  onBlockClick={handleBlockClick}
                  onBreaksChange={handleBreaksChange}
                  focusBlockIndex={focusBlock}
                  ratio={renderDraft.ratio}
                  pageIndex={xhsPage}
                  onXhsPageChange={handleXhsPageChange}
                  xhsHeader={renderDraft.header}
                  xhsPageNum={renderDraft.pageNum}
                  xhsCoverSub={renderDraft.coverSub}
                  xhsCoverBadge={renderDraft.coverBadge}
                  texture={renderDraft.texture || undefined}
                  deco={renderDraft.deco || undefined}
                />
              )}
            </div>
          </div>
          {/* 点段落改文本：改的是这一块的 markdown 源码段（行区间来自 token.map），
              不用 IR 反序列化——markdown 始终是唯一真相源，导出与自动保存都不必改道 */}
          {editing?.line && (
            <div
              className="shrink-0 border-t border-border bg-surface-1"
              data-testid="mdstudio-block-editor"
            >
              <div className="flex shrink-0 items-center gap-2 px-3 py-1.5">
                <Icon name="edit" size={12} className="shrink-0 text-primary" />
                <span className="text-xs font-medium text-text-secondary">
                  {t('mdstudio.edit.title')}
                </span>
                <span className="text-[10px] text-text-disabled">
                  {t('mdstudio.edit.range', {
                    from: editing.line[0] + 1,
                    to: editing.line[1],
                  })}
                </span>
                <button
                  type="button"
                  aria-label={t('mdstudio.edit.close')}
                  onClick={() => setEditing(null)}
                  className="ml-auto rounded p-1 text-text-disabled transition-colors hover:text-text-primary"
                >
                  <Icon name="close" size={12} />
                </button>
              </div>
              <textarea
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                spellCheck={false}
                aria-label={t('mdstudio.edit.text')}
                className="h-24 w-full resize-none overflow-y-auto bg-transparent px-3 pb-2 font-mono text-xs leading-relaxed text-text-primary outline-none"
              />
              <div className="flex shrink-0 justify-end gap-2 px-3 pb-2">
                <Button size="sm" variant="secondary" onClick={() => setEditing(null)}>
                  {t('common.cancel')}
                </Button>
                <Button size="sm" onClick={commitBlockEdit}>
                  {t('mdstudio.edit.save')}
                </Button>
              </div>
            </div>
          )}
        </section>

        {/* 右栏：平台 → 主题 → 微调 → 导出 */}
        <aside className="w-72 shrink-0 border-l border-border bg-surface-1">
          {draft && (
            <InspectorPanel
              platform={draft.platform}
              themeId={draft.theme_id}
              overrides={draft.overrides}
              footer={draft.footer}
              qr={draft.qr}
              xhsInfo={xhsInfo}
              exporting={exporting}
              onPlatformChange={changePlatform}
              onThemeChange={(id) => patchDraft({ theme_id: id })}
              onOverridesChange={(o) => patchDraft({ overrides: o })}
              onFooterChange={(f) => patchDraft({ footer: f })}
              onQrChange={(q) => patchDraft({ qr: q })}
              ratio={draft.ratio}
              coverSub={draft.coverSub}
              coverBadge={draft.coverBadge}
              pageNum={draft.pageNum}
              header={draft.header}
              texture={draft.texture}
              deco={draft.deco}
              onRatioChange={(r) => patchDraft({ ratio: r })}
              onCoverFieldChange={(key, value) => patchDraft({ [key]: value } as Partial<DraftState>)}
              onExport={(a) => void runExport(a)}
            />
          )}
        </aside>
      </div>

      {/* 批量出图：一个批次一个 ZIP，逐篇状态与失败原因都在弹层里 */}
      <BatchExportModal
        open={batchOpen}
        targets={batchTargets}
        onClose={() => setBatchOpen(false)}
        onFinished={(ok) => {
          if (ok) {
            setBatchIds([])
            setBatchMode(false)
          }
        }}
      />
    </div>
  )
}
