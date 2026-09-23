import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { api, fileUrl, API_BASE, docsApi } from '../../api'
import { useDownloadStore } from '../../stores/download'
import {
  Badge,
  Button,
  CopyButton,
  EmptyState,
  Icon,
  Modal,
  Progress,
  QueryErrorState,
  SkeletonCard,
  SkeletonList,
  useToast,
  type IconName,
} from '../../components/ui'
import { useEventSource } from '../../hooks/useEventSource'
import type { DownloadStatus, DownloadTask } from '../../api/download'
import type { FileInfo, LibraryEntry } from '../../api'
import ReactMarkdown from 'react-markdown'
import {
  AssetCard,
  AssetDetailRow,
  DownloadBar,
  QuickPreview,
  PreviewOverlay,
  ViewSwitch,
  formatBytes,
  type AssetView,
} from './AssetViews'
import { DuplicatesModal, OrganizeModal } from './AssetTools'

const STATUS_TONE: Record<DownloadStatus, 'neutral' | 'success' | 'warning' | 'error' | 'primary'> = {
  pending: 'neutral',
  downloading: 'primary',
  completed: 'success',
  failed: 'error',
  cancelled: 'warning',
}

interface RootsTree {
  base: string
  root: string
  output: string
  downloads: string
  tree: { name: string; path: string; children: RootsTree['tree'] }[]
}

type KindFilter = 'all' | 'active' | 'tasks' | 'image' | 'video' | 'audio' | 'document' | 'other'
type SortKey = 'name' | 'size' | 'mtime'

const KIND_TAB_ICON: Record<Exclude<KindFilter, 'active' | 'tasks'>, IconName> = {
  all: 'layers',
  image: 'library',
  video: 'studio',
  audio: 'console',
  document: 'briefs',
  other: 'more',
}

const STATUS_ICON: Record<DownloadStatus, IconName> = {
  pending: 'clock',
  downloading: 'downloads',
  completed: 'check',
  failed: 'alert',
  cancelled: 'close',
}

export function AssetsPage() {
  const { t } = useTranslation()
  const toast = useToast()
  const queryClient = useQueryClient()
  const tasks = useDownloadStore((s) => s.tasks)
  const upsert = useDownloadStore((s) => s.upsert)
  const setAll = useDownloadStore((s) => s.setAll)

  // ---- 素材根目录（tag 系统：素材空间 = data_dir 根）----
  const [searchParams] = useSearchParams()
  // 支持 /assets?path=... 深链（Studio 运行完成后跳转到这里查看产物）。
  // 同路由重复导航不重挂载 → 参数变化用 effect 响应（§35 数据驱动）
  const [currentPath, setCurrentPath] = useState<string | null>(null)
  useEffect(() => {
    const initial = searchParams.get('path')
    if (initial && initial.trim()) setCurrentPath(initial.trim())
  }, [searchParams])
  const roots = useQuery({ queryKey: ['library-roots'], queryFn: () => api.get<RootsTree>('/api/library/roots') })
  const scan = useQuery({
    queryKey: ['library-scan', currentPath],
    queryFn: () =>
      api.get<{ path: string; entries: LibraryEntry[] }>(`/api/library/scan?path=${encodeURIComponent(currentPath!)}`),
    enabled: !!currentPath,
  })
  // 根目录扫描：左侧 Tag 系统 = 固定导航（递归聚合素材根目录全部标签，
  // 不随浏览路径变化；不递归则子目录文件的标签永远不出现）
  const rootScan = useQuery({
    queryKey: ['library-root-scan', roots.data?.root],
    queryFn: () =>
      api.get<{ path: string; entries: LibraryEntry[] }>(
        `/api/library/scan?path=${encodeURIComponent(roots.data!.root)}&recursive=true&limit=2000`,
      ),
    enabled: !!roots.data?.root,
  })
  // 默认落在素材根目录（指定的数据目录），而非固定子文件夹
  useEffect(() => {
    if (!currentPath && roots.data?.root) setCurrentPath(roots.data.root)
  }, [roots.data, currentPath])

  // ---- 过滤 / 搜索 / Tag / 视图 ----
  const [kind, setKind] = useState<KindFilter>('all')
  const [query, setQuery] = useState('')
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [view, setView] = useState<AssetView>('grid')
  const [sortKey, setSortKey] = useState<SortKey>('mtime')
  const [sortAsc, setSortAsc] = useState(false)
  const queryRef = useRef<HTMLInputElement>(null)

  // ---- 下载任务（SSE 驱动）----
  const { data: initialTasks } = useQuery({
    queryKey: ['download-tasks'],
    queryFn: () => api.get<DownloadTask[]>('/api/download/tasks'),
  })
  useEffect(() => {
    if (initialTasks) setAll(initialTasks)
  }, [initialTasks, setAll])
  useEventSource(`${API_BASE}/api/download/tasks/events`, (ev) => {
    const data = JSON.parse(ev.data) as { event: string; task: DownloadTask }
    upsert(data.task)
    if (data.event === 'progress') {
      const prev = lastSample.current[data.task.id]
      const now = performance.now()
      if (prev && now - prev.t > 0) {
        const rate = ((data.task.downloaded_bytes - prev.bytes) * 1000) / (now - prev.t)
        setSpeeds((s) => ({ ...s, [data.task.id]: rate }))
      }
      lastSample.current[data.task.id] = { bytes: data.task.downloaded_bytes, t: now }
    } else {
      delete lastSample.current[data.task.id]
      setSpeeds((s) => (s[data.task.id] ? { ...s, [data.task.id]: 0 } : s))
    }
  })
  const [speeds, setSpeeds] = useState<Record<string, number>>({})
  const lastSample = useRef<Record<string, { bytes: number; t: number }>>({})

  // ---- 预览 / 右键 / 下载条 / 文档 ----
  const [quickPreview, setQuickPreview] = useState<LibraryEntry | null>(null)
  const [detail, setDetail] = useState<FileInfo | null>(null)
  // ---- 多选组合（v0.26）：path 集合，跨过滤保持，切换目录时清空 ----
  const [selected, setSelected] = useState<Set<string>>(new Set())
  useEffect(() => {
    setSelected(new Set())
  }, [currentPath])
  function toggleSelect(path: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }
  const [menu, setMenu] = useState<{ x: number; y: number; entry: LibraryEntry } | null>(null)
  const [tagEdit, setTagEdit] = useState<LibraryEntry | null>(null)
  const [tagDraft, setTagDraft] = useState('')
  const [downloadBarOpen, setDownloadBarOpen] = useState(false)
  const [confirm, setConfirm] = useState<{ title: string; onConfirm: () => void } | null>(null)
  const [sideTab, setSideTab] = useState<'assets' | 'docs'>('assets')
  const [docPreview, setDocPreview] = useState<string | null>(null)
  const [editingDoc, setEditingDoc] = useState(false)
  const [docDraft, setDocDraft] = useState('')
  const [newDocOpen, setNewDocOpen] = useState(false)
  const [docName, setDocName] = useState('')

  const { data: docFiles = [] } = useQuery({ queryKey: ['docs'], queryFn: docsApi.list })
  const { data: doc } = useQuery({
    queryKey: ['docs-content', docPreview],
    queryFn: () => docsApi.content(docPreview as string),
    enabled: !!docPreview,
  })

  const activeTasks = useMemo(
    () => tasks.filter((task) => task.status === 'pending' || task.status === 'downloading'),
    [tasks],
  )

  const entries = scan.data?.entries ?? []
  const selectedEntries = useMemo(
    () => entries.filter((e) => selected.has(e.path)),
    [entries, selected],
  )
  // 产物目录（output 下，含 studio / pipeline）：素材库专用提示（标签/下载引导）不适用
  const isArtifactsPath = !!(
    roots.data?.output &&
    (currentPath === roots.data.output || currentPath?.startsWith(`${roots.data.output}/`))
  )
  // Tag 聚合（素材根目录，固定导航）：按出现次数统计
  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const e of rootScan.data?.entries ?? []) {
      for (const tag of e.tags ?? []) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1)
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }, [rootScan.data?.entries])
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return entries
      .filter((e) => kind === 'all' || e.kind === kind)
      .filter((e) => !tagFilter || (e.tags ?? []).includes(tagFilter))
      .filter(
        (e) =>
          !q ||
          e.name.toLowerCase().includes(q) ||
          (e.tags ?? []).some((tg) => tg.toLowerCase().includes(q)) ||
          (e.note ?? '').toLowerCase().includes(q),
      )
  }, [entries, kind, query, tagFilter])
  // 全局排序（对标 Heartstone：名称 / 大小 / 修改时间，三视图共享，默认时间降序；
  // 目录恒前置（Finder 风格），组内再按排序键排列）
  const sorted = useMemo(() => {
    const list = [...filtered]
    list.sort((a, b) => {
      const ad = a.kind === 'directory' ? 0 : 1
      const bd = b.kind === 'directory' ? 0 : 1
      if (ad !== bd) return ad - bd
      const cmp =
        sortKey === 'name' ? a.name.localeCompare(b.name) : sortKey === 'size' ? a.size - b.size : a.mtime - b.mtime
      return sortAsc ? cmp : -cmp
    })
    return list
  }, [filtered, sortKey, sortAsc])

  const kindCount = (k: string) => (k === 'all' ? entries.length : entries.filter((e) => e.kind === k).length)

  // ---- 素材智能整理 / 查重（v0.2.3，参考 Eagle AI Action / Find Duplicates）----
  const [organizeOpen, setOrganizeOpen] = useState(false)
  const [dupOpen, setDupOpen] = useState(false)
  const organizePaths = filtered.filter((e) => e.kind !== 'directory').map((e) => e.path)
  const refreshAssets = () => {
    void scan.refetch()
    void rootScan.refetch()
  }

  // ---- ⌘K 聚焦搜索 / ⌘N 新下载 / Esc 关浮层 ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey
      if (meta && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        queryRef.current?.focus()
      }
      if (meta && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        setDownloadBarOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const openEntry = (entry: LibraryEntry) => {
    if (entry.kind === 'directory') {
      // 浏览目录即退出标签过滤（产物入口/标签互斥：同一时间只激活一个）
      setTagFilter(null)
      setCurrentPath(entry.path)
    } else setDetail({ ...entry })
  }

  async function saveTags(entry: LibraryEntry, tags: string[]) {
    try {
      await api.post('/api/library/tags', { path: entry.path, tags })
      await scan.refetch()
      toast(t('assets.tagged'), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  function deleteFile(entry: LibraryEntry) {
    setConfirm({
      title: t('common.deleteConfirm', { name: entry.name }),
      onConfirm: () => {
        void (async () => {
          try {
            await api.delete(`/api/library/file?path=${encodeURIComponent(entry.path)}`)
            await scan.refetch()
            toast(t('assets.deleted'), 'success')
          } catch (err) {
            toast(err instanceof Error ? err.message : String(err), 'error')
          }
        })()
      },
    })
  }

  // ---- 项目文档（文档 = 素材根目录下可维护的 .md，项目级功能）----
  async function saveDoc() {
    if (!docPreview) return
    try {
      await docsApi.save(docPreview, docDraft)
      await queryClient.invalidateQueries({ queryKey: ['docs-content'] })
      setEditingDoc(false)
      toast(t('docs.saved'), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  function removeDoc() {
    if (!docPreview) return
    setConfirm({
      title: t('docs.deleteConfirm'),
      onConfirm: () => {
        void (async () => {
          try {
            await docsApi.remove(docPreview!)
            setDocPreview(null)
            setEditingDoc(false)
            await queryClient.invalidateQueries({ queryKey: ['docs'] })
            toast(t('docs.deleted'), 'success')
          } catch (err) {
            toast(err instanceof Error ? err.message : String(err), 'error')
          }
        })()
      },
    })
  }

  async function createDoc() {
    const name = docName.trim().replace(/^\/+/, '')
    if (!name) return
    const path = name.toLowerCase().endsWith('.md') ? name : `${name}.md`
    try {
      await docsApi.save(path, '')
      setNewDocOpen(false)
      setDocName('')
      setDocPreview(path)
      setEditingDoc(true)
      setDocDraft('')
      await queryClient.invalidateQueries({ queryKey: ['docs'] })
      toast(t('docs.created'), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  return (
    <div className="flex h-full">
      {/* 项目树 / 文档 */}
      <aside className="flex w-48 shrink-0 flex-col border-r border-border bg-surface-1">
        <div className="flex border-b border-border">
          <button
            type="button"
            onClick={() => setSideTab('assets')}
            className={`flex-1 border-b-2 px-2 py-2 text-xs font-medium transition-colors ${
              sideTab === 'assets'
                ? 'border-primary text-text-primary'
                : 'border-transparent text-text-secondary hover:text-text-primary'
            }`}
          >
            {t('assets.tabAssets')}
          </button>
          <button
            type="button"
            onClick={() => setSideTab('docs')}
            className={`flex-1 border-b-2 px-2 py-2 text-xs font-medium transition-colors ${
              sideTab === 'docs'
                ? 'border-primary text-text-primary'
                : 'border-transparent text-text-secondary hover:text-text-primary'
            }`}
          >
            {t('assets.tabDocs')}
          </button>
        </div>
        {sideTab === 'assets' ? (
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {/* 产物入口：按自动化流程分 studio / pipeline（快捷访问） */}
            {roots.data?.output && (
              <>
                <div className="px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-text-disabled">
                  {t('assets.artifactsDir')}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setTagFilter(null)
                    setCurrentPath(`${roots.data!.output}/studio`)
                  }}
                  className={`flex w-full items-center gap-1.5 border-l-2 px-2 py-1.5 text-left text-sm transition-colors hover:bg-surface-2 ${
                    currentPath?.startsWith(`${roots.data.output}/studio`)
                      ? 'border-primary bg-surface-2 text-text-primary'
                      : 'border-transparent text-text-secondary'
                  }`}
                >
                  <Icon name="studio" size={13} className="shrink-0" />
                  <span className="truncate">Studio</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setTagFilter(null)
                    setCurrentPath(`${roots.data!.output}/pipeline`)
                  }}
                  className={`flex w-full items-center gap-1.5 border-l-2 px-2 py-1.5 text-left text-sm transition-colors hover:bg-surface-2 ${
                    currentPath?.startsWith(`${roots.data.output}/pipeline`)
                      ? 'border-primary bg-surface-2 text-text-primary'
                      : 'border-transparent text-text-secondary'
                  }`}
                >
                  <Icon name="console" size={13} className="shrink-0" />
                  <span className="truncate">Pipeline</span>
                </button>
              </>
            )}
            <div className="my-2 h-px bg-border" />
            {/* Tag 系统：素材根目录文件的标签；点击切换（再点移除），
                激活标签时回到根目录并退出产物入口（同一时间只激活一个） */}
            {tagCounts.map(([tag, count]) => (
              <button
                key={tag}
                type="button"
                onClick={() => {
                  const activating = tagFilter !== tag
                  setTagFilter(activating ? tag : null)
                  if (activating) setCurrentPath(roots.data?.root ?? null)
                }}
                className={`flex w-full items-center gap-1.5 border-l-2 px-2 py-1.5 text-left text-sm transition-colors hover:bg-surface-2 ${
                  tagFilter === tag
                    ? 'border-primary bg-surface-2 text-text-primary'
                    : 'border-transparent text-text-secondary'
                }`}
              >
                <Icon name="tag" size={13} className="shrink-0" />
                <span className="truncate">{tag}</span>
                <span className="ml-auto text-[10px] text-text-disabled">
                  {tagFilter === tag ? t('assets.removeTag') : count}
                </span>
              </button>
            ))}
            {tagCounts.length === 0 && (
              <p className="px-2 pt-3 text-xs leading-relaxed text-text-disabled">{t('assets.noTags')}</p>
            )}
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            <div className="p-1">
              <Button size="sm" className="w-full" onClick={() => setNewDocOpen(true)}>
                <Icon name="plus" size={13} />
                {t('docs.newDoc')}
              </Button>
            </div>
            {docFiles.map((file) => (
              <button
                key={file}
                type="button"
                onClick={() => {
                  setDocPreview(file)
                  setEditingDoc(false)
                }}
                className={`flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-sm transition-colors hover:bg-surface-2 ${
                  docPreview === file ? 'border-l-2 border-primary bg-surface-2 text-text-primary' : 'border-l-2 border-transparent text-text-secondary'
                }`}
              >
                <Icon name="file" size={13} className="shrink-0" />
                <span className="truncate">{file}</span>
              </button>
            ))}
            {docFiles.length === 0 && (
              <p className="px-2 pt-2 text-xs leading-relaxed text-text-disabled">{t('docs.emptyList')}</p>
            )}
          </div>
        )}
        <div className="border-t border-border p-2 text-[10px] text-text-disabled">
          {sideTab === 'docs' ? t('assets.tabDocs') : currentPath ?? roots.data?.base ?? ''}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* 顶栏：标题 + 搜索 + 下载 */}
        <div className="flex items-center gap-3 border-b border-border bg-surface-1 px-4 py-2">
          <h1 className="text-sm font-semibold text-text-primary">{t('assets.title')}</h1>
          <div className="ml-auto flex items-center gap-2">
            <div className="relative">
              <Icon name="search" size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-text-disabled" />
              <input
                ref={queryRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('assets.search')}
                className="h-9 w-56 border border-border bg-surface-1 pl-7 pr-2 text-xs text-text-primary outline-none placeholder:text-text-disabled focus:border-primary"
              />
            </div>
            <Button onClick={() => setDownloadBarOpen((v) => !v)}>
              <Icon name="downloads" size={14} />
              {t('download.title')}
            </Button>
          </div>
        </div>

        {/* 文档工作区（sideTab === 'docs'）：项目文档的阅读/编辑 */}
        {sideTab === 'docs' ? (
          <>
            <div className="flex items-center gap-2 border-b border-border bg-surface-1 px-4 py-1.5">
              <Icon name="file" size={13} className="shrink-0 text-text-secondary" />
              <span className="truncate text-sm font-medium text-text-primary">{docPreview ?? t('assets.tabDocs')}</span>
              <div className="ml-auto flex shrink-0 items-center gap-1.5">
                {docPreview &&
                  (editingDoc ? (
                    <>
                      <Button size="sm" onClick={() => void saveDoc()}>
                        <Icon name="check" size={13} />
                        {t('docs.save')}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditingDoc(false)}>
                        {t('docs.cancel')}
                      </Button>
                    </>
                  ) : (
                    <>
                      <CopyButton text={doc?.content ?? ''} label={t('common.copy')} />
                      <Button size="sm" variant="ghost" onClick={() => setEditingDoc(true)}>
                        <Icon name="pen" size={13} />
                        {t('docs.edit')}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void removeDoc()}>
                        <Icon name="trash" size={13} />
                        {t('docs.delete')}
                      </Button>
                    </>
                  ))}
                <Button size="sm" onClick={() => setNewDocOpen(true)}>
                  <Icon name="plus" size={13} />
                  {t('docs.newDoc')}
                </Button>
              </div>
            </div>
            {docPreview ? (
              editingDoc ? (
                <textarea
                  value={docDraft}
                  onChange={(e) => setDocDraft(e.target.value)}
                  placeholder={t('docs.editPlaceholder')}
                  className="min-h-0 flex-1 resize-none bg-surface-1 p-4 font-mono text-sm leading-relaxed text-text-primary outline-none placeholder:text-text-disabled"
                />
              ) : doc ? (
                <article className="md-body min-h-0 flex-1 overflow-y-auto p-6">
                  <ReactMarkdown>{doc.content}</ReactMarkdown>
                </article>
              ) : (
                <div className="flex-1 p-4">
                  <SkeletonList rows={5} height={44} />
                </div>
              )
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 text-text-secondary">
                <Icon name="file" size={32} className="text-text-disabled" />
                <p className="text-sm">{t('docs.empty')}</p>
              </div>
            )}
          </>
        ) : (
          <>
        {/* 分类胶囊 */}
        <div className="flex items-center gap-1 border-b border-border px-4 py-1.5">
          {(
            [
              { id: 'all', label: t('library.tabs.all'), icon: KIND_TAB_ICON.all },
              { id: 'active', label: t('assets.active'), icon: 'downloads' as IconName },
              { id: 'tasks', label: t('assets.tasks'), icon: 'clock' as IconName },
              { id: 'image', label: t('library.tabs.image'), icon: KIND_TAB_ICON.image },
              { id: 'video', label: t('library.tabs.video'), icon: KIND_TAB_ICON.video },
              { id: 'audio', label: t('library.tabs.audio'), icon: KIND_TAB_ICON.audio },
              { id: 'document', label: t('library.tabs.document'), icon: KIND_TAB_ICON.document },
              { id: 'other', label: t('library.tabs.other'), icon: KIND_TAB_ICON.other },
            ] as Array<{ id: KindFilter; label: string; icon: IconName }>
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setKind(tab.id)}
              className={`flex items-center gap-1 border px-2.5 py-0.5 text-xs transition-colors ${
                kind === tab.id
                  ? 'border-primary bg-primary/15 text-primary'
                  : 'border-transparent text-text-secondary hover:border-border hover:text-text-primary'
              }`}
            >
              <Icon name={tab.icon} size={11} />
              {tab.label}
              <span className="text-text-disabled">
                {tab.id === 'active'
                  ? activeTasks.length
                  : tab.id === 'tasks'
                    ? tasks.length
                    : tab.id === 'all'
                      ? entries.length
                      : kindCount(tab.id)}
              </span>
            </button>
          ))}
          {/* 全局排序（对标 Heartstone：名称 / 大小 / 时间，同键翻转方向） */}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {(['name', 'size', 'mtime'] as SortKey[]).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => {
                  if (sortKey === k) setSortAsc((v) => !v)
                  else {
                    setSortKey(k)
                    setSortAsc(false)
                  }
                }}
                className={`flex items-center gap-1 border px-2 py-0.5 text-xs transition-colors ${
                  sortKey === k
                    ? 'border-primary bg-primary/15 text-primary'
                    : 'border-transparent text-text-secondary hover:border-border hover:text-text-primary'
                }`}
              >
                {k === 'name' ? t('library.sortName') : k === 'size' ? t('library.sortSize') : t('library.sortDate')}
                {sortKey === k && <Icon name={sortAsc ? 'sort-asc' : 'sort-desc'} size={11} />}
              </button>
            ))}
            <span className="h-4 w-px bg-border" />
            <ViewSwitch value={view} onChange={setView} />
            <span className="h-4 w-px bg-border" />
            <button
              type="button"
              onClick={() => setOrganizeOpen(true)}
              disabled={organizePaths.length === 0}
              title={t('assets.organize')}
              className="flex items-center gap-1 border border-border px-2 py-0.5 text-xs text-text-secondary transition-colors hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Icon name="wand" size={12} />
              {t('assets.organize')}
            </button>
            <button
              type="button"
              onClick={() => setDupOpen(true)}
              disabled={!currentPath}
              title={t('assets.duplicates')}
              className="flex items-center gap-1 border border-border px-2 py-0.5 text-xs text-text-secondary transition-colors hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Icon name="copy" size={12} />
              {t('assets.duplicates')}
            </button>
          </div>
        </div>

        {/* 路径面包屑 + 返回上一级 */}
        {currentPath && (
          <div className="flex items-center gap-1 border-b border-border bg-surface-1 px-4 py-1.5">
            <button
              type="button"
              onClick={() => {
                if (!currentPath) return
                const parent = currentPath.slice(0, currentPath.lastIndexOf('/'))
                setCurrentPath(parent || roots.data?.root || null)
              }}
              disabled={!roots.data?.root || currentPath === roots.data.root}
              className="flex shrink-0 items-center gap-1 border border-border px-2 py-0.5 text-xs text-text-secondary transition-colors hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Icon name="chevron-left" size={12} />
              {t('assets.up')}
            </button>
            <div className="flex min-w-0 items-center gap-1 overflow-x-auto font-mono text-xs text-text-secondary">
              {(() => {
                const root = roots.data?.root ?? ''
                const isAbs = currentPath.startsWith('/')
                const segments = currentPath.split('/').filter(Boolean)
                const ellipsis: React.ReactNode[] =
                  isAbs && (!root || currentPath === root || !currentPath.startsWith(root))
                    ? [<span key="ellipsis" className="text-text-secondary">…</span>]
                    : []
                const buildPath = (i: number) =>
                  (isAbs ? '/' : '') + segments.slice(0, i + 1).join('/')
                return [
                  ...ellipsis,
                  ...segments.map((seg, i) => {
                    const path = buildPath(i)
                    const isLast = i === segments.length - 1
                    return (
                      <span key={path} className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          disabled={isLast}
                          onClick={() => setCurrentPath(path)}
                          className={`transition-colors ${
                            isLast
                              ? 'cursor-default text-text-primary'
                              : 'text-text-secondary hover:text-primary disabled:cursor-default'
                          }`}
                        >
                          {seg}
                        </button>
                        {!isLast && <Icon name="chevron-right" size={10} className="text-text-disabled" />}
                      </span>
                    )
                  }),
                ] as React.ReactNode[]
              })()}
            </div>
            <span className="ml-auto shrink-0 text-[10px] text-text-disabled">{entries.length} {t('assets.entryCount')}</span>
          </div>
        )}

        {/* 主体 */}
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {/* 进行中的任务 */}
          {(kind === 'all' || kind === 'active') && activeTasks.length > 0 && (
            <div className={kind === 'all' ? 'mb-4' : ''}>
              {kind === 'all' && <p className="mb-2 text-xs font-medium text-text-secondary">{t('assets.active')}</p>}
              <ul className="divide-y divide-border border border-border">
                {activeTasks.map((task) => (
                  <ActiveTaskRow
                    key={task.id}
                    task={task}
                    speed={speeds[task.id] ?? 0}
                    onCancel={() => void taskAction(task.id)}
                  />
                ))}
              </ul>
            </div>
          )}
          {kind === 'active' && activeTasks.length === 0 && (
            <EmptyState icon="downloads" title={t('assets.noActive')} />
          )}

          {/* 下载记录（HeartStone 风格任务列表：封面/标题/状态/进度/操作） */}
          {kind === 'tasks' && tasks.length > 0 && (
            <div className="mb-4">
              <ul className="divide-y divide-border border border-border">
                {[...tasks]
                  .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
                  .map((task) => (
                    <TaskRecordRow
                      key={task.id}
                      task={task}
                      speed={speeds[task.id] ?? 0}
                      onCancel={() => void taskAction(task.id)}
                      onRetry={() => void taskRetry(task.id)}
                      onShowInFolder={() => window.electron?.showItemInFolder(task.file_path!)}
                      onDelete={() => taskDelete(task.id)}
                    />
                  ))}
              </ul>
            </div>
          )}
          {kind === 'tasks' && tasks.length === 0 && (
            <EmptyState icon="downloads" title={t('assets.noTasks')} />
          )}

          {/* 素材视图（两模式：网格 / 详情列表，数据源与操作集共享） */}
          {scan.isError ? (
            <QueryErrorState message={t('error.queryFailed', { detail: currentPath ?? '' })} onRetry={() => void scan.refetch()} />
          ) : scan.isLoading ? (
            <SkeletonCard count={8} className="p-3" />
          ) : filtered.length === 0 && kind !== 'active' && kind !== 'tasks' ? (
            <EmptyState
              icon="downloads"
              title={isArtifactsPath ? t('assets.emptyArtifacts') : t('assets.empty')}
              description={isArtifactsPath ? undefined : t('assets.emptyHint')}
              action={
                !isArtifactsPath ? (
                  <Button onClick={() => setDownloadBarOpen(true)}>
                    <Icon name="downloads" size={14} />
                    {t('assets.goDownload')}
                  </Button>
                ) : undefined
              }
            />
          ) : view === 'grid' ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
              {sorted.map((entry) => (
                <div key={entry.path} className="relative">
                  {entry.kind !== 'directory' && (
                    <input
                      type="checkbox"
                      checked={selected.has(entry.path)}
                      onChange={() => toggleSelect(entry.path)}
                      title={t('assets.select', '加入组合')}
                      className="absolute left-1.5 top-1.5 z-10 h-4 w-4 accent-primary"
                      onClick={(e) => e.stopPropagation()}
                    />
                  )}
                  <AssetCard
                    entry={entry}
                    onPreview={() => (entry.kind === 'directory' ? openEntry(entry) : setQuickPreview(entry))}
                    onDetail={() => openEntry(entry)}
                    onContext={(x, y) => setMenu({ x, y, entry })}
                    onFavorite={(e) => {
                      const tags = e.tags ?? []
                      void saveTags(e, tags.includes('⭐') ? tags.filter((x) => x !== '⭐') : [...tags, '⭐'])
                    }}
                    onShowInFolder={window.electron ? () => window.electron?.showItemInFolder(entry.path) : undefined}
                    onDelete={() => deleteFile(entry)}
                  />
                </div>
              ))}
            </div>
          ) : (
            <ul className="space-y-1">
              {sorted.map((entry) => (
                <li key={entry.path} className="flex items-center gap-2">
                  {entry.kind !== 'directory' && (
                    <input
                      type="checkbox"
                      checked={selected.has(entry.path)}
                      onChange={() => toggleSelect(entry.path)}
                      title={t('assets.select', '加入组合')}
                      className="h-4 w-4 shrink-0 accent-primary"
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <AssetDetailRow
                      entry={entry}
                      onPreview={() => (entry.kind === 'directory' ? openEntry(entry) : setQuickPreview(entry))}
                      onDetail={() => openEntry(entry)}
                      onContext={(x, y) => setMenu({ x, y, entry })}
                      onShowInFolder={window.electron ? () => window.electron?.showItemInFolder(entry.path) : undefined}
                      onDelete={() => deleteFile(entry)}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* 组合预览抽屉（v0.26）：多选集横向排列，验证拼接节奏 */}
        {selectedEntries.length > 0 && (
          <div className="border-t border-border bg-surface-1 px-4 py-2">
            <div className="mb-1.5 flex items-center gap-2">
              <span className="text-xs font-medium text-text-primary">
                {t('assets.combo', '组合预览')} · {selectedEntries.length}
              </span>
              <button
                type="button"
                onClick={() => setSelected(new Set())}
                className="text-xs text-text-disabled hover:text-error"
              >
                {t('common.clear', '清空')}
              </button>
            </div>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {selectedEntries.map((e, i) => (
                <div key={e.path} className="flex w-36 shrink-0 flex-col gap-1 rounded border border-border bg-surface-2 p-1.5">
                  <div className="flex h-16 items-center justify-center overflow-hidden bg-surface-1">
                    {e.kind === 'image' ? (
                      <img src={fileUrl(e.path)} alt={e.name} className="max-h-full max-w-full object-contain" />
                    ) : e.kind === 'video' ? (
                      <video src={fileUrl(e.path)} className="max-h-full max-w-full" preload="metadata" />
                    ) : e.kind === 'audio' ? (
                      <Icon name="console" size={20} className="text-success" />
                    ) : (
                      <Icon name="briefs" size={20} className="text-text-disabled" />
                    )}
                  </div>
                  <p className="truncate text-[10px] text-text-secondary" title={e.name}>
                    {i + 1}. {e.name}
                  </p>
                  {e.note && (
                    <p className="truncate text-[10px] text-text-disabled" title={e.note}>
                      {e.note}
                    </p>
                  )}
                  <button
                    type="button"
                    onClick={() => toggleSelect(e.path)}
                    className="self-end text-[10px] text-text-disabled hover:text-error"
                  >
                    {t('common.remove', '移除')}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 底部状态栏：进行中任务数 + 当前路径（对标 Heartstone 下载页底部） */}
        <div className="flex items-center gap-2 border-t border-border bg-surface-1 px-4 py-1.5">
          <Icon name="downloads" size={13} className="shrink-0 text-text-disabled" />
          <span className="text-xs text-text-secondary">
            {activeTasks.length > 0
              ? t('download.runningCount', { count: activeTasks.length })
              : t('assets.noActive')}
          </span>
          <span className="ml-auto truncate font-mono text-[10px] text-text-disabled" title={currentPath ?? ''}>
            {currentPath ?? ''}
          </span>
        </div>
        </>
        )}
      </div>

      {/* 打标 Modal */}
      <Modal open={!!tagEdit} onClose={() => setTagEdit(null)} width={420} title={t('assets.tag')}>
        {tagEdit && (
          <div className="flex flex-col gap-3">
            <p className="truncate text-xs text-text-secondary">{tagEdit.name}</p>
            <input
              autoFocus
              value={tagDraft}
              onChange={(e) => setTagDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const tags = tagDraft.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
                  void saveTags(tagEdit, tags)
                  setTagEdit(null)
                }
              }}
              placeholder={t('assets.tagPlaceholder')}
              className="h-9 border border-border bg-surface-1 px-3 text-sm text-text-primary outline-none placeholder:text-text-disabled focus:border-primary"
            />
            <div className="flex flex-wrap gap-1.5">
              {['download', 'bilibili', 'youtube', 'assets.tagSelected', 'assets.tagDraft'].map((suggest) => {
                const active = tagDraft.split(/[,，]/).map((s) => s.trim()).includes(suggest)
                return (
                  <button
                    key={suggest}
                    type="button"
                    onClick={() => {
                      const tags = tagDraft.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
                      setTagDraft(active ? tags.filter((x) => x !== suggest).join(', ') : [...tags, suggest].join(', '))
                    }}
                    className={`border px-2 py-1 text-xs transition-colors ${
                      active ? 'border-primary bg-primary/10 text-primary' : 'border-border text-text-secondary hover:border-text-disabled'
                    }`}
                  >
                    {suggest.startsWith('assets.') ? t(suggest) : suggest}
                  </button>
                )
              })}
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="secondary"
                onClick={() => {
                  const tags = tagDraft.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
                  void saveTags(tagEdit, tags)
                  setTagEdit(null)
                }}
              >
                {t('common.save')}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* 下载条（内联于素材视图，不弹窗） */}
      <DownloadBar
        open={downloadBarOpen}
        onClose={() => setDownloadBarOpen(false)}
        onStarted={() => {
          setDownloadBarOpen(false)
          setKind('tasks')
        }}
      />

      {/* 删除确认（统一 Modal，替代 window.confirm） */}
      <Modal open={!!confirm} onClose={() => setConfirm(null)} width={400} title={t('common.confirm')}>
        <p className="text-sm leading-relaxed text-text-secondary">{confirm?.title}</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirm(null)}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              confirm?.onConfirm()
              setConfirm(null)
            }}
          >
            <Icon name="trash" size={14} />
            {t('common.delete')}
          </Button>
        </div>
      </Modal>

      {/* 新建项目文档 */}
      <Modal open={newDocOpen} onClose={() => setNewDocOpen(false)} width={400} title={t('docs.newDoc')}>
        <div className="flex flex-col gap-3">
          <input
            autoFocus
            value={docName}
            onChange={(e) => setDocName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void createDoc()
            }}
            placeholder={t('docs.namePlaceholder')}
            className="h-9 border border-border bg-surface-1 px-3 text-sm text-text-primary outline-none placeholder:text-text-disabled focus:border-primary"
          />
          <div className="flex justify-end">
            <Button onClick={() => void createDoc()} disabled={!docName.trim()}>
              <Icon name="check" size={14} />
              {t('common.save')}
            </Button>
          </div>
        </div>
      </Modal>

      {/* 快速预览（点图像区直达媒体） */}
      <QuickPreview entry={quickPreview} onClose={() => setQuickPreview(null)} />
      <OrganizeModal
        open={organizeOpen}
        onClose={() => setOrganizeOpen(false)}
        paths={organizePaths}
        onDone={refreshAssets}
      />
      <DuplicatesModal
        open={dupOpen}
        onClose={() => setDupOpen(false)}
        path={currentPath}
        onDone={refreshAssets}
      />

      {/* 详情浮层（点名称：元数据 / 管理） */}
      <PreviewOverlay
        preview={detail}
        onClose={() => setDetail(null)}
        onDelete={async () => {
          if (detail) await deleteFile(detail)
          setDetail(null)
        }}
      />

      {/* 右键菜单 */}
      {menu && (
        <div
          className="hz-overlay-in fixed z-50 w-44 rounded-md border border-border bg-surface-1 py-1 text-sm shadow-lg"
          style={{ left: menu.x, top: menu.y }}
          onMouseLeave={() => setMenu(null)}
        >
          {menu.entry.kind !== 'directory' && window.electron && (
            <button
              type="button"
              onClick={() => {
                window.electron?.showItemInFolder(menu.entry.path)
                setMenu(null)
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-text-primary hover:bg-surface-2"
            >
              <Icon name="folder" size={13} />
              {t('common.showInFolder')}
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setTagEdit(menu.entry)
              setTagDraft((menu.entry.tags ?? []).join(', '))
              setMenu(null)
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-text-primary hover:bg-surface-2"
          >
            <Icon name="tag" size={13} />
            {t('assets.tag')}
          </button>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(menu.entry.path)
              setMenu(null)
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-text-primary hover:bg-surface-2"
          >
            <Icon name="file" size={13} />
            {t('assets.copyPath')}
          </button>
          {menu.entry.kind !== 'directory' && (
            <button
              type="button"
              onClick={() => {
                void deleteFile(menu.entry)
                setMenu(null)
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-error hover:bg-surface-2"
            >
              <Icon name="trash" size={13} />
              {t('common.delete')}
            </button>
          )}
        </div>
      )}
    </div>
  )

  async function taskAction(taskId: string) {
    try {
      const task = await api.post<DownloadTask>(`/api/download/tasks/${taskId}/cancel`)
      upsert(task)
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  async function taskRetry(taskId: string) {
    try {
      const task = await api.post<DownloadTask>(`/api/download/tasks/${taskId}/retry`)
      upsert(task)
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  function taskDelete(taskId: string) {
    const task = tasks.find((x) => x.id === taskId)
    setConfirm({
      title: t('common.deleteConfirm', { name: (task?.metadata?.title_hint as string) ?? task?.url ?? taskId }),
      onConfirm: () => {
        void (async () => {
          try {
            await api.delete(`/api/download/tasks/${taskId}`)
            useDownloadStore.getState().remove(taskId)
          } catch (err) {
            toast(err instanceof Error ? err.message : String(err), 'error')
          }
        })()
      },
    })
  }
}

// ---- 任务行（对标 Heartstone TaskItem：状态 Badge + 进度 + 速度 / 错误原因 / 保存路径）----

function ActiveTaskRow({
  task,
  speed,
  onCancel,
}: {
  task: DownloadTask
  speed: number
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const title = (task.metadata?.title_hint as string | undefined) ?? task.url
  return (
    <li className="flex items-center gap-3 px-3 py-2">
      <Badge tone={STATUS_TONE[task.status]}>
        <Icon name={STATUS_ICON[task.status]} size={11} />
        {t(`download.status.${task.status}`)}
      </Badge>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-text-primary" title={title}>
          {title}
        </p>
        <div className="mt-1.5 flex items-center gap-3">
          <Progress
            value={task.status === 'pending' ? undefined : task.progress}
            className="h-1 flex-1"
          />
          <span className="shrink-0 text-xs text-text-secondary">
            {task.status === 'downloading'
              ? `${formatBytes(task.downloaded_bytes)} / ${formatBytes(task.total_bytes)}`
              : formatBytes(task.total_bytes)}
          </span>
        </div>
        {task.status === 'downloading' && speed > 0 && (
          <p className="mt-0.5 text-[10px] text-text-disabled">{t('download.speed', { speed: formatBytes(speed) })}</p>
        )}
        {task.status === 'failed' && task.error && (
          <p className="mt-0.5 truncate text-xs text-error" title={task.error}>
            {t('download.errorDetail', { error: task.error })}
          </p>
        )}
      </div>
      {task.status === 'downloading' && (
        <Button size="sm" variant="ghost" onClick={onCancel}>
          <Icon name="stop" size={12} />
          {t('download.actions.cancel')}
        </Button>
      )}
    </li>
  )
}

function TaskRecordRow({
  task,
  speed,
  onCancel,
  onRetry,
  onDelete,
  onShowInFolder,
}: {
  task: DownloadTask
  speed: number
  onCancel: () => void
  onRetry: () => void
  onDelete: () => void
  onShowInFolder: () => void
}) {
  const { t } = useTranslation()
  const title = (task.metadata?.title_hint as string | undefined) ?? task.url
  return (
    <li className="flex items-center gap-4 px-3 py-2.5">
      {/* 封面 */}
      <div className="flex h-14 w-24 shrink-0 items-center justify-center overflow-hidden bg-surface-2">
        {task.metadata?.thumbnail && typeof task.metadata.thumbnail === 'string' ? (
          <img
            src={fileUrl(task.metadata.thumbnail)}
            alt=""
            className="h-full w-full object-cover"
            loading="lazy"
            onError={(e) => {
              e.currentTarget.style.display = 'none'
            }}
          />
        ) : (
          <Icon name={task.status === 'completed' ? 'studio' : 'downloads'} size={18} className="text-text-disabled" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-text-primary" title={title}>
          {title}
        </p>
        <div className="mt-1.5 flex items-center gap-3">
          <Progress
            value={task.status === 'pending' ? undefined : task.status === 'completed' ? 100 : task.progress}
            className="h-1 max-w-72 flex-1"
          />
          <span className="shrink-0 text-xs text-text-secondary">
            {task.status === 'downloading'
              ? `${formatBytes(task.downloaded_bytes)} / ${formatBytes(task.total_bytes)}`
              : formatBytes(task.total_bytes)}
          </span>
        </div>
        <p className="mt-0.5 truncate text-[11px] text-text-disabled">{task.url}</p>
        {task.status === 'downloading' && speed > 0 && (
          <p className="mt-0.5 text-[10px] text-text-disabled">{t('download.speed', { speed: formatBytes(speed) })}</p>
        )}
        {task.status === 'failed' && task.error && (
          <p className="mt-0.5 truncate text-xs text-error" title={task.error}>
            {t('download.errorDetail', { error: task.error })}
          </p>
        )}
        {task.status === 'completed' && task.file_path && (
          <p className="mt-0.5 truncate text-[11px] text-success" title={task.file_path}>
            {t('download.savedTo', { path: task.file_path })}
          </p>
        )}
      </div>
      <Badge tone={STATUS_TONE[task.status]}>
        <Icon name={STATUS_ICON[task.status]} size={11} />
        {t(`download.status.${task.status}`)}
      </Badge>
      <div className="flex shrink-0 items-center gap-1">
        {task.status === 'downloading' && (
          <Button size="sm" variant="ghost" onClick={onCancel}>
            <Icon name="stop" size={12} />
            {t('download.actions.cancel')}
          </Button>
        )}
        {task.status === 'failed' && (
          <Button size="sm" variant="ghost" onClick={onRetry}>
            <Icon name="refresh" size={12} />
            {t('download.actions.retry')}
          </Button>
        )}
        {task.status === 'completed' && task.file_path && window.electron && (
          <Button size="sm" variant="ghost" onClick={onShowInFolder}>
            <Icon name="folder" size={12} />
            {t('common.showInFolder')}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onDelete}>
          <Icon name="trash" size={12} />
          {t('download.actions.delete')}
        </Button>
      </div>
    </li>
  )
}

