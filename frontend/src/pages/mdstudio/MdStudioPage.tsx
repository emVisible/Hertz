/** MD Studio 顶页：图文工坊三栏工作站（设计 §5）。
 *
 * 编排：排版稿 CRUD（react-query）+ 本地 draft（自动保存 800ms debounce PUT）
 * + 画布重排（150ms debounce）+ 平台导出动作。
 * 持久化字段映射：footer（小红书署名）后端无独立列，存在 cover JSON 的 footer 键里
 * （cover 是自由 JSON 槽，§6 模型预留位）。
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
  renderLongImage,
  xhsCaption,
  xhsCards,
  type ThemeOverrides,
} from '@hertz/mdcore'

import { layoutApi, type LayoutDoc, type LayoutPlatform } from '../../api'
import { Button, EmptyState, Icon, Input, Select, ToggleChip, useToast } from '../../components/ui'
import { CanvasPanel, type XhsRenderInfo } from './CanvasPanel'
import { InspectorPanel, type ExportAction } from './InspectorPanel'
import { LayoutListPanel } from './LayoutListPanel'

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
}

type SaveState = 'saved' | 'dirty' | 'saving'

function draftFromDoc(doc: LayoutDoc): DraftState {
  return {
    title: doc.title,
    source_md: doc.source_md,
    platform: doc.platform,
    theme_id: doc.theme_id || defaultThemeFor(doc.platform).id,
    overrides: doc.overrides as ThemeOverrides,
    // footer 存 cover.footer（封面/品牌位 JSON 槽）
    footer: typeof doc.cover?.footer === 'string' ? doc.cover.footer : '',
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

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
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
  const [zoom, setZoom] = useState(1)
  const [dark, setDark] = useState(false)
  const [xhsInfo, setXhsInfo] = useState<XhsRenderInfo>({ pageCount: 0, overflow: false })

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
    setDraft(draftFromDoc(doc))
    setSaveState('saved')
  }, [docQuery.data, selectedId])

  const patchDraft = useCallback((patch: Partial<DraftState>) => {
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev))
    setSaveState('dirty')
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
          cover: { footer: snapshot.footer },
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

  const handleXhsInfo = useCallback((info: XhsRenderInfo) => {
    setXhsInfo((prev) =>
      prev.pageCount === info.pageCount && prev.overflow === info.overflow ? prev : info,
    )
  }, [])

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
      setDraft(draftFromDoc(doc))
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

  /** 切平台：稿的 platform + theme_id 一起换到该平台默认主题（自动保存接管落库） */
  const changePlatform = (p: LayoutPlatform) => {
    patchDraft({ platform: p, theme_id: defaultThemeFor(p).id })
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
        const res = xhsCards(ir, { theme: draft.theme_id, overrides: draft.overrides, footer: draft.footer })
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
    } catch {
      toast(t('mdstudio.export.failed'), 'error')
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

      <div className="flex min-h-0 flex-1">
        {/* 左栏：排版稿列表 + 导入 + 源文轻编辑 */}
        <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-surface-1">
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
            />
          </div>
          {/* 源文轻编辑：不复用 MarkdownEditor——它自带右侧预览，与中栏画布职责重复；
              这里只要 raw 编辑面（样式同 MarkdownEditor 左半，保持全项目手感一致） */}
          {draft && (
            <div className="flex h-2/5 shrink-0 flex-col border-t border-border">
              <div className="flex shrink-0 items-center justify-between px-3 py-1.5">
                <span className="text-xs font-medium text-text-secondary">{t('mdstudio.source.title')}</span>
                <span className="text-[10px] text-text-disabled">
                  {t('briefs.charCount', { count: draft.source_md.length })}
                </span>
              </div>
              <textarea
                value={draft.source_md}
                onChange={(e) => patchDraft({ source_md: e.target.value })}
                spellCheck={false}
                placeholder={t('mdstudio.source.placeholder')}
                className="min-h-0 flex-1 resize-none overflow-y-auto bg-transparent px-3 pb-2 font-mono text-xs leading-relaxed text-text-primary outline-none placeholder:text-text-disabled"
              />
            </div>
          )}
        </aside>

        {/* 中栏：平台感知画布 */}
        <section className="flex min-w-0 flex-1 flex-col">
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
            {/* 深色预览：微信预览切真深色主题「晚风」；xhs/zhihu 暂无深色主题，
                容器套深底 + 内容反色滤镜近似（切片 E 做逐主题深色款） */}
            <ToggleChip active={dark} onClick={() => setDark((v) => !v)} title={t('mdstudio.canvas.dark')}>
              <Icon name="moon" size={11} /> {t('mdstudio.canvas.dark')}
            </ToggleChip>
          </div>
          <div
            className={`min-h-0 flex-1 overflow-auto p-4 transition-colors duration-150 ${dark ? 'bg-[#14161c]' : ''}`}
          >
            <div
              className={`mx-auto w-fit rounded-lg border border-border p-3 shadow-md ${
                dark ? 'bg-[#1c1f28]' : 'bg-surface-1'
              }`}
              style={dark && draft?.platform !== 'wechat' ? { filter: 'invert(0.92) hue-rotate(180deg)' } : undefined}
            >
              {renderDraft && (
                <CanvasPanel
                  sourceMd={renderDraft.source_md}
                  platform={renderDraft.platform}
                  themeId={renderDraft.theme_id}
                  overrides={renderDraft.overrides}
                  footer={renderDraft.footer}
                  zoom={zoom}
                  dark={dark}
                  mountRef={mountRef}
                  onXhsInfo={handleXhsInfo}
                />
              )}
            </div>
          </div>
        </section>

        {/* 右栏：平台 → 主题 → 微调 → 导出 */}
        <aside className="w-72 shrink-0 border-l border-border bg-surface-1">
          {draft && (
            <InspectorPanel
              platform={draft.platform}
              themeId={draft.theme_id}
              overrides={draft.overrides}
              footer={draft.footer}
              xhsInfo={xhsInfo}
              exporting={exporting}
              onPlatformChange={changePlatform}
              onThemeChange={(id) => patchDraft({ theme_id: id })}
              onOverridesChange={(o) => patchDraft({ overrides: o })}
              onFooterChange={(f) => patchDraft({ footer: f })}
              onExport={(a) => void runExport(a)}
            />
          )}
        </aside>
      </div>
    </div>
  )
}
