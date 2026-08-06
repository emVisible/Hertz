import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { api, fileUrl, API_BASE, docsApi, type ParseResult } from '../../api'
import { useDownloadStore } from '../../stores/download'
import {
  Badge,
  Button,
  Icon,
  Modal,
  Progress,
  QueryErrorState,
  Select,
  Spinner,
  useToast,
  type IconName,
} from '../../components/ui'
import { useEventSource } from '../../hooks/useEventSource'
import type { DownloadStatus, DownloadTask } from '../../api/download'
import type { FileInfo, LibraryEntry } from '../../api'
import ReactMarkdown from 'react-markdown'

const KIND_ICON: Record<string, IconName> = {
  video: 'studio',
  audio: 'console',
  image: 'library',
  document: 'briefs',
  directory: 'folder',
  other: 'more',
}

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

function formatBytes(n: number | null | undefined): string {
  if (n == null) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`
}

function formatDuration(seconds?: number): string {
  if (!seconds) return '—'
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

type KindFilter = 'all' | 'active' | 'tasks' | 'image' | 'video' | 'audio' | 'document' | 'other'

export function AssetsPage() {
  const { t } = useTranslation()
  const toast = useToast()
  const queryClient = useQueryClient()
  const tasks = useDownloadStore((s) => s.tasks)
  const upsert = useDownloadStore((s) => s.upsert)
  const setAll = useDownloadStore((s) => s.setAll)

  // ---- 素材根目录（tag 系统：素材空间 = data_dir 根）----
  const [searchParams] = useSearchParams()
  // 支持 /assets?path=... 深链（Studio 运行完成后跳转到这里查看产物）
  const [currentPath, setCurrentPath] = useState<string | null>(() => {
    const initial = searchParams.get('path')
    return initial && initial.trim() ? initial.trim() : null
  })
  const roots = useQuery({ queryKey: ['library-roots'], queryFn: () => api.get<RootsTree>('/api/library/roots') })
  const scan = useQuery({
    queryKey: ['library-scan', currentPath],
    queryFn: () =>
      api.get<{ path: string; entries: LibraryEntry[] }>(`/api/library/scan?path=${encodeURIComponent(currentPath!)}`),
    enabled: !!currentPath,
  })
  // 根目录扫描：左侧 Tag 系统 = 固定导航（标签始终来自素材根目录，不随浏览路径变化）
  const rootScan = useQuery({
    queryKey: ['library-root-scan', roots.data?.root],
    queryFn: () =>
      api.get<{ path: string; entries: LibraryEntry[] }>(`/api/library/scan?path=${encodeURIComponent(roots.data!.root)}`),
    enabled: !!roots.data?.root,
  })
  // 默认落在素材根目录（指定的数据目录），而非固定子文件夹
  useEffect(() => {
    if (!currentPath && roots.data?.root) setCurrentPath(roots.data.root)
  }, [roots.data, currentPath])

  // ---- 过滤 / 搜索 / Tag ----
  const [kind, setKind] = useState<KindFilter>('all')
  const [query, setQuery] = useState('')
  const [tagFilter, setTagFilter] = useState<string | null>(null)
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
  })

  // ---- 预览 / 右键 / 下载条 / 文档 ----
  const [quickPreview, setQuickPreview] = useState<LibraryEntry | null>(null)
  const [detail, setDetail] = useState<FileInfo | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; entry: LibraryEntry } | null>(null)
  const [tagEdit, setTagEdit] = useState<LibraryEntry | null>(null)
  const [tagDraft, setTagDraft] = useState('')
  const [downloadBarOpen, setDownloadBarOpen] = useState(false)
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
      .filter((e) => !q || e.name.toLowerCase().includes(q))
  }, [entries, kind, query, tagFilter])

  const kindCount = (k: string) => (k === 'all' ? entries.length : entries.filter((e) => e.kind === k).length)

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
    if (entry.kind === 'directory') setCurrentPath(entry.path)
    else setDetail({ ...entry })
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

  async function deleteFile(entry: LibraryEntry) {
    try {
      await api.delete(`/api/library/file?path=${encodeURIComponent(entry.path)}`)
      await scan.refetch()
      toast(t('assets.deleted'), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
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

  async function removeDoc() {
    if (!docPreview || !window.confirm(t('docs.deleteConfirm'))) return
    try {
      await docsApi.remove(docPreview)
      setDocPreview(null)
      setEditingDoc(false)
      await queryClient.invalidateQueries({ queryKey: ['docs'] })
      toast(t('docs.deleted'), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
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
                  onClick={() => setCurrentPath(`${roots.data!.output}/studio`)}
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
                  onClick={() => setCurrentPath(`${roots.data!.output}/pipeline`)}
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
            {/* Tag 系统：素材根目录文件的标签 */}
            {tagCounts.map(([tag, count]) => (
              <button
                key={tag}
                type="button"
                onClick={() => setTagFilter(tag)}
                className={`flex w-full items-center gap-1.5 border-l-2 px-2 py-1.5 text-left text-sm transition-colors hover:bg-surface-2 ${
                  tagFilter === tag
                    ? 'border-primary bg-surface-2 text-text-primary'
                    : 'border-transparent text-text-secondary'
                }`}
              >
                <Icon name="tag" size={13} className="shrink-0" />
                <span className="truncate">{tag}</span>
                <span className="ml-auto text-[10px] text-text-disabled">{count}</span>
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
                className="h-7 w-56 border border-border bg-surface-1 pl-7 pr-2 text-xs text-text-primary outline-none placeholder:text-text-disabled focus:border-primary"
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
                <div className="flex flex-1 items-center justify-center">
                  <Spinner />
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
              { id: 'all', label: t('library.tabs.all') },
              { id: 'active', label: t('assets.active') },
              { id: 'tasks', label: t('assets.tasks') },
              { id: 'image', label: t('library.tabs.image') },
              { id: 'video', label: t('library.tabs.video') },
              { id: 'audio', label: t('library.tabs.audio') },
              { id: 'document', label: t('library.tabs.document') },
              { id: 'other', label: t('library.tabs.other') },
            ] as Array<{ id: KindFilter; label: string }>
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setKind(tab.id)}
              className={`border px-2.5 py-0.5 text-xs transition-colors ${
                kind === tab.id
                  ? 'border-primary bg-primary/15 text-primary'
                  : 'border-transparent text-text-secondary hover:border-border hover:text-text-primary'
              }`}
            >
              {tab.label}
              <span className="ml-1 text-text-disabled">
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
          {kind === 'all' && activeTasks.length > 0 && (
            <div className="mb-4">
              <p className="mb-2 text-xs font-medium text-text-secondary">{t('assets.active')}</p>
              <ul className="divide-y divide-border border border-border">
                {activeTasks.map((task) => (
                  <li key={task.id} className="flex items-center gap-3 px-3 py-2">
                    <Badge tone={STATUS_TONE[task.status]}>{t(`download.status.${task.status}`)}</Badge>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-text-primary" title={task.url}>{task.url}</p>
                      <div className="mt-1.5 flex items-center gap-3">
                        <Progress value={task.status === 'downloading' ? task.progress : 0} className="h-1 flex-1" />
                        <span className="shrink-0 text-xs text-text-secondary">
                          {task.status === 'downloading'
                            ? `${formatBytes(task.downloaded_bytes)} / ${formatBytes(task.total_bytes)}`
                            : formatBytes(task.total_bytes)}
                        </span>
                      </div>
                    </div>
                    {task.status === 'downloading' && (
                      <Button size="sm" variant="ghost" onClick={() => void taskAction(task.id)}>
                        {t('download.actions.cancel')}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {kind === 'active' && activeTasks.length > 0 && (
            <div className="mb-4">
              <ul className="divide-y divide-border border border-border">
                {activeTasks.map((task) => (
                  <li key={task.id} className="flex items-center gap-3 px-3 py-2">
                    <Badge tone={STATUS_TONE[task.status]}>{t(`download.status.${task.status}`)}</Badge>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-text-primary" title={task.url}>{task.url}</p>
                      <div className="mt-1.5 flex items-center gap-3">
                        <Progress value={task.status === 'downloading' ? task.progress : 0} className="h-1 flex-1" />
                        <span className="shrink-0 text-xs text-text-secondary">
                          {task.status === 'downloading'
                            ? `${formatBytes(task.downloaded_bytes)} / ${formatBytes(task.total_bytes)}`
                            : formatBytes(task.total_bytes)}
                        </span>
                      </div>
                    </div>
                    {task.status === 'downloading' && (
                      <Button size="sm" variant="ghost" onClick={() => void taskAction(task.id)}>
                        {t('download.actions.cancel')}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {kind === 'active' && activeTasks.length === 0 && (
            <p className="p-6 text-center text-sm text-text-disabled">{t('assets.noActive')}</p>
          )}

          {/* 下载记录（HeartStone 风格任务列表：封面/标题/状态/进度/操作） */}
          {kind === 'tasks' && tasks.length > 0 && (
            <div className="mb-4">
              <ul className="divide-y divide-border border border-border">
                  {[...tasks]
                    .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
                    .map((task) => (
                      <li key={task.id} className="flex items-center gap-4 px-3 py-2.5">
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
                          <p className="truncate text-sm text-text-primary" title={(task.metadata?.title_hint as string) ?? task.url}>
                            {(task.metadata?.title_hint as string) ?? task.url}
                          </p>
                          <div className="mt-1.5 flex items-center gap-3">
                            <Progress
                              value={task.status === 'downloading' ? task.progress : task.status === 'completed' ? 100 : task.progress}
                              className="h-1 max-w-72 flex-1"
                            />
                            <span className="shrink-0 text-xs text-text-secondary">
                              {task.status === 'downloading'
                                ? `${formatBytes(task.downloaded_bytes)} / ${formatBytes(task.total_bytes)}`
                                : formatBytes(task.total_bytes)}
                            </span>
                          </div>
                          <p className="mt-0.5 truncate text-[11px] text-text-disabled">{task.url}</p>
                        </div>
                        <Badge tone={STATUS_TONE[task.status]}>{t(`download.status.${task.status}`)}</Badge>
                        <div className="flex shrink-0 items-center gap-1">
                          {task.status === 'downloading' && (
                            <Button size="sm" variant="ghost" onClick={() => void taskAction(task.id)}>
                              {t('download.actions.cancel')}
                            </Button>
                          )}
                          {task.status === 'failed' && (
                            <Button size="sm" variant="ghost" onClick={() => void taskRetry(task.id)}>
                              {t('download.actions.retry')}
                            </Button>
                          )}
                          {task.status === 'completed' && task.file_path && window.electron && (
                            <Button size="sm" variant="ghost" onClick={() => window.electron?.showItemInFolder(task.file_path!)}>
                              {t('common.showInFolder')}
                            </Button>
                          )}
                          <Button size="sm" variant="ghost" onClick={() => void taskDelete(task.id)}>
                            {t('download.actions.delete')}
                          </Button>
                        </div>
                      </li>
                    ))}
                </ul>
            </div>
          )}
          {kind === 'tasks' && tasks.length === 0 && (
            <p className="p-6 text-center text-sm text-text-disabled">{t('assets.noTasks')}</p>
          )}

          {/* 素材网格 */}
          {scan.isError ? (
            <QueryErrorState message={t('error.queryFailed', { detail: currentPath ?? '' })} onRetry={() => void scan.refetch()} />
          ) : scan.isLoading ? (
            <div className="flex h-40 items-center justify-center"><Spinner /></div>
          ) : filtered.length === 0 && kind !== 'active' ? (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-text-secondary">
              <Icon name="downloads" size={32} className="text-text-disabled" />
              {isArtifactsPath ? (
                <p className="text-sm">{t('assets.emptyArtifacts')}</p>
              ) : (
                <>
                  <p className="text-sm">{t('assets.empty')}</p>
                  <p className="text-xs opacity-60">{t('assets.emptyHint')}</p>
                </>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
              {filtered.map((entry) => (
                <AssetCard
                  key={entry.path}
                  entry={entry}
                  onPreview={() => (entry.kind === 'directory' ? openEntry(entry) : setQuickPreview(entry))}
                  onDetail={() => openEntry(entry)}
                  onContext={(x, y) => setMenu({ x, y, entry })}
                />
              ))}
            </div>
          )}
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
              {['download', 'bilibili', 'youtube', '精选', '草稿'].map((suggest) => {
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
                    {suggest}
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
          className="fixed z-50 w-44 border border-border bg-surface-1 py-1 text-sm shadow-2xl"
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

  async function taskDelete(taskId: string) {
    try {
      await api.delete(`/api/download/tasks/${taskId}`)
      useDownloadStore.getState().remove(taskId)
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }
}

function AssetCard({
  entry,
  onPreview,
  onDetail,
  onContext,
}: {
  entry: LibraryEntry
  onPreview: () => void
  onDetail: () => void
  onContext: (x: number, y: number) => void
}) {
  return (
    <div
      onContextMenu={(e) => {
        e.preventDefault()
        onContext(e.clientX, e.clientY)
      }}
      className="group flex flex-col border border-transparent p-1.5 transition-colors hover:border-border hover:bg-surface-1"
    >
      {/* 图像区：图片/视频/音频直接预览；文件夹直接进入 */}
      <button
        type="button"
        onClick={onPreview}
        className={`relative flex h-24 w-full items-center justify-center overflow-hidden bg-surface-2 ${
          entry.kind === 'directory' ? 'cursor-pointer' : 'cursor-zoom-in'
        }`}
      >
        {entry.kind === 'image' ? (
          <img src={fileUrl(entry.path)} alt={entry.name} className="h-full w-full object-cover" loading="lazy" />
        ) : entry.thumb ? (
          <img src={fileUrl(entry.thumb)} alt={entry.name} className="h-full w-full object-cover" loading="lazy" />
        ) : (
          <Icon name={KIND_ICON[entry.kind]} size={26} className="text-text-disabled" />
        )}
        {(entry.kind === 'video' || entry.kind === 'audio') && (
          <span className="absolute inset-0 flex items-center justify-center bg-black/25 opacity-0 transition-opacity group-hover:opacity-100">
            <Icon name="play" size={26} className="text-white/90" />
          </span>
        )}
        {/* Tag 徽章 */}
        {(entry.tags ?? []).length > 0 && (
          <span className="absolute left-1 top-1 flex max-w-[90%] gap-1 overflow-hidden">
            {(entry.tags ?? []).slice(0, 2).map((tag) => (
              <span
                key={tag}
                className="truncate border border-border bg-black/55 px-1.5 py-0.5 text-[9px] font-medium text-text-primary backdrop-blur-sm"
              >
                {tag}
              </span>
            ))}
          </span>
        )}
      </button>
      {/* 名称区：进入详情（元数据 / 管理） */}
      <button
        type="button"
        onClick={onDetail}
        className="mt-1.5 w-full truncate text-center text-xs text-text-secondary hover:text-text-primary"
        title={entry.name}
      >
        {entry.name}
      </button>
    </div>
  )
}

// ---- 下载条：内联于素材视图（不弹窗），粘贴链接 → 解析 → 封面/格式 → 开始 ----
function DownloadBar({
  open,
  onClose,
  onStarted,
}: {
  open: boolean
  onClose: () => void
  onStarted: () => void
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const upsert = useDownloadStore((s) => s.upsert)
  const [url, setUrl] = useState('')
  const [parsing, setParsing] = useState(false)
  const [result, setResult] = useState<ParseResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [formatId, setFormatId] = useState('')
  const [selectedAssets, setSelectedAssets] = useState<Set<string>>(new Set())
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setUrl('')
      setResult(null)
      setError(null)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open])

  async function parse() {
    if (!url.trim()) return
    setParsing(true)
    setError(null)
    setResult(null)
    try {
      const r = await api.get<ParseResult>(`/api/download/parse?url=${encodeURIComponent(url.trim())}`)
      setResult(r)
      if (r.qualities?.length) setFormatId(r.qualities[0].format_id)
      else if (r.formats?.length) setFormatId(r.formats[0].format_id)
      if (r.assets?.length) setSelectedAssets(new Set(r.assets.map((a) => a.url)))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setParsing(false)
    }
  }

  async function start() {
    if (!result) return
    try {
      if (result.kind === 'page' && result.assets) {
        for (const asset of result.assets) {
          if (selectedAssets.has(asset.url)) {
            const task = await api.post<DownloadTask>('/api/download/tasks', {
              url: asset.url,
              title: result.title,
            })
            await api.post(`/api/download/tasks/${task.id}/start`)
            upsert(task)
          }
        }
      } else {
        const task = await api.post<DownloadTask>('/api/download/tasks', {
          url: url.trim(),
          title: result.title,
        })
        await api.post(`/api/download/tasks/${task.id}/start`, { format_id: formatId || undefined })
        upsert(task)
      }
      toast(t('download.started'), 'success')
      onStarted()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  if (!open) return null

  return (
    <div className="shrink-0 border-b border-border bg-surface-1/80 px-4 py-3 backdrop-blur-sm">
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Icon name="downloads" size={15} className="shrink-0 text-text-secondary" />
          <input
            ref={inputRef}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={t('download.urlPlaceholder')}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void parse()
            }}
            className="h-9 min-w-0 flex-1 border border-border bg-surface-1 px-3 text-sm text-text-primary outline-none placeholder:text-text-disabled focus:border-primary"
          />
          <Button onClick={() => void parse()} loading={parsing}>
            {t('download.parse')}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {t('common.close')}
          </Button>
        </div>
      </div>
      {error && <p className="mt-2 text-xs text-error">{error}</p>}

      {/* 解析结果：直接内联展示（含封面） */}
      {result && result.kind === 'page' && (
        <div className="mt-3 flex flex-col gap-2 border border-border bg-surface-1 p-3">
          <p className="text-sm font-medium">{t('download.assetsFound', { count: result.assets?.length ?? 0 })}</p>
          <ul className="max-h-44 space-y-1 overflow-y-auto">
            {result.assets?.map((a) => (
              <li key={a.url} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selectedAssets.has(a.url)}
                  onChange={(e) => {
                    const next = new Set(selectedAssets)
                    if (e.target.checked) next.add(a.url)
                    else next.delete(a.url)
                    setSelectedAssets(next)
                  }}
                />
                <Badge tone="neutral">{a.kind}</Badge>
                <span className="truncate text-text-secondary">{a.name}</span>
              </li>
            ))}
          </ul>
          <div>
            <Button onClick={() => void start()}>
              <Icon name="downloads" size={14} />
              {t('download.start')}
            </Button>
          </div>
        </div>
      )}

      {result && result.kind !== 'page' && (
        <div className="mt-3 flex items-center gap-4 border border-border bg-surface-1 p-3">
          {result.thumbnail && (
            <img
              src={result.thumbnail}
              alt={result.title ?? ''}
              className="h-24 w-40 shrink-0 object-cover"
              onError={(e) => {
                e.currentTarget.style.display = 'none'
              }}
            />
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold leading-snug">{result.title}</p>
            <p className="mt-1 text-xs text-text-secondary">
              {result.uploader && `${t('download.uploader')}: ${result.uploader} · `}
              {`${t('download.duration')}: ${formatDuration(result.duration)}`}
            </p>
            {result.formats && result.formats.length > 0 && (
              <div className="mt-2 max-w-xs">
                <Select
                  label={t('download.format')}
                  value={formatId}
                  onChange={(e) => setFormatId(e.target.value)}
                  options={(result.qualities ?? result.formats ?? []).map((f) => ({
                    value: f.format_id,
                    label: f.label,
                  }))}
                />
              </div>
            )}
          </div>
          <Button onClick={() => void start()}>
            <Icon name="downloads" size={14} />
            {t('download.start')}
          </Button>
        </div>
      )}
    </div>
  )
}

// ---- 快速预览：点击图像区直达媒体，不再先进详情 ----
function QuickPreview({ entry, onClose }: { entry: LibraryEntry | null; onClose: () => void }) {
  const { t } = useTranslation()
  return (
    <Modal open={!!entry} onClose={onClose} width={820} title={entry?.name}>
      {entry && (
        <div className="flex flex-col gap-3">
          <div className="flex min-h-64 items-center justify-center bg-surface-2 p-3">
            {entry.kind === 'image' && (
              <img src={fileUrl(entry.path)} alt={entry.name} className="max-h-[65vh] max-w-full object-contain" />
            )}
            {entry.kind === 'video' && (
              <video src={fileUrl(entry.path)} controls autoPlay className="max-h-[65vh] max-w-full" />
            )}
            {entry.kind === 'audio' && <audio src={fileUrl(entry.path)} controls autoPlay className="w-full" />}
            {entry.kind === 'document' && <DocumentText path={entry.path} />}
            {entry.kind === 'other' && (
              <div className="flex flex-col items-center gap-2 py-10 text-text-disabled">
                <Icon name="more" size={32} />
                <span className="text-xs">{t('library.noPreview')}</span>
              </div>
            )}
          </div>
          <p className="truncate text-center text-xs text-text-secondary">
            {entry.name} · {formatBytes(entry.size)}
          </p>
        </div>
      )}
    </Modal>
  )
}

function DocumentText({ path }: { path: string }) {
  const { data } = useQuery({
    queryKey: ['asset-doc', path],
    queryFn: () => api.getText<string>(`/api/library/file?path=${encodeURIComponent(path)}`),
    enabled: !!path,
  })
  if (data === undefined) {
    return <div className="flex h-40 items-center justify-center"><Spinner /></div>
  }
  return (
    <pre className="max-h-[65vh] w-full overflow-auto whitespace-pre-wrap p-3 font-mono text-xs leading-relaxed text-text-primary">
      {data.slice(0, 30000)}
    </pre>
  )
}

// ---- 预览浮层 ----
function PreviewOverlay({
  preview,
  onClose,
  onDelete,
}: {
  preview: FileInfo | null
  onClose: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const info = useQuery({
    queryKey: ['library-info', preview?.path],
    queryFn: () => api.get<FileInfo>(`/api/library/info?path=${encodeURIComponent(preview!.path)}`),
    enabled: !!preview,
  })
  const [textContent, setTextContent] = useState<string | null>(null)

  useEffect(() => {
    setTextContent(null)
    if (!preview || preview.kind !== 'document') return
    void api
      .getText<string>(`/api/library/file?path=${encodeURIComponent(preview.path)}`)
      .then(setTextContent)
      .catch(() => setTextContent(null))
  }, [preview])

  const meta = info.data?.media

  return (
    <Modal open={!!preview} onClose={onClose} width={760} title={preview?.name}>
      {preview && (
        <div className="flex gap-4">
          <div className="flex min-w-0 flex-1 items-center justify-center bg-surface-2 p-2">
            {preview.kind === 'image' && (
              <img src={fileUrl(preview.path)} alt={preview.name} className="max-h-96 max-w-full object-contain" />
            )}
            {preview.kind === 'video' && (
              <video src={fileUrl(preview.path)} controls className="max-h-96 max-w-full" />
            )}
            {preview.kind === 'audio' && <audio src={fileUrl(preview.path)} controls className="w-full" />}
            {preview.kind === 'document' &&
              (textContent ? (
                <pre className="max-h-96 w-full overflow-auto whitespace-pre-wrap p-3 font-mono text-xs text-text-primary">
                  {textContent.slice(0, 20000)}
                </pre>
              ) : (
                <div className="flex flex-col items-center gap-2 py-8 text-text-disabled">
                  <Icon name="briefs" size={32} />
                  <span className="text-xs">{t('library.noPreview')}</span>
                </div>
              ))}
          </div>
          <div className="w-52 shrink-0">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">
              {t('library.metadata')}
            </h3>
            {info.isLoading ? (
              <Spinner size={16} />
            ) : (
              <dl className="space-y-1.5 text-xs">
                <MetaRow label={t('library.meta.name')} value={info.data?.name ?? preview.name} />
                <MetaRow label={t('library.meta.size')} value={formatBytes(info.data?.size ?? preview.size)} />
                {meta?.codec && <MetaRow label={t('library.meta.codec')} value={meta.codec} />}
                {meta?.width && meta.height && (
                  <MetaRow label={t('library.meta.resolution')} value={`${meta.width}×${meta.height}`} />
                )}
                {meta?.duration && <MetaRow label={t('library.meta.duration')} value={formatDuration(meta.duration)} />}
              </dl>
            )}
            <div className="mt-3 flex flex-col gap-2">
              {window.electron && (
                <Button size="sm" variant="secondary" onClick={() => window.electron?.showItemInFolder(preview.path)}>
                  {t('library.openInFolder')}
                </Button>
              )}
              <Button size="sm" variant="danger" onClick={() => void onDelete()}>
                {t('common.delete')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  )
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-text-disabled">{label}</dt>
      <dd className="truncate text-text-primary">{value}</dd>
    </div>
  )
}
