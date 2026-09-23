import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { useDownloadStore } from '../../stores/download'
import type { DownloadTask } from '../../api/download'

import { api, fileUrl, type AssetSnippet, type FileInfo, type LibraryEntry, type ParseResult } from '../../api'
import { Badge, Button, CopyButton, Icon, Modal, Select, Spinner, useToast, type IconName } from '../../components/ui'

const KIND_ICON: Record<string, IconName> = {
  video: 'studio',
  audio: 'console',
  image: 'library',
  document: 'briefs',
  directory: 'folder',
  other: 'more',
}

// 类型图标着色（区分不同类型文件；目录/图片/视频=主色系，音频=绿色，文档/其他=中性）
function kindIconTone(kind: string): string {
  switch (kind) {
    case 'directory':
    case 'video':
    case 'image':
      return 'text-primary'
    case 'audio':
      return 'text-success'
    case 'document':
      return 'text-text-secondary'
    default:
      return 'text-text-disabled'
  }
}

function kindIconBox(kind: string): string {
  switch (kind) {
    case 'directory':
    case 'video':
    case 'image':
      return 'bg-primary/10 text-primary'
    case 'audio':
      return 'bg-success/10 text-success'
    case 'document':
      return 'bg-surface-2 text-text-secondary'
    default:
      return 'bg-surface-2 text-text-disabled'
  }
}


export function formatBytes(n: number | null | undefined): string {
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

export function formatDuration(seconds?: number): string {
  if (!seconds) return '—'
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export function formatMtime(ts: number): string {
  if (!ts) return '—'
  return new Date(ts * 1000).toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// ---- 视图模式切换（对标 Heartstone Segmented：网格 / 详情列表，数据源与操作集共享）----
export type AssetView = 'grid' | 'detail'

const VIEW_ICON: Record<AssetView, IconName> = { grid: 'grid', detail: 'list' }

export function ViewSwitch({ value, onChange }: { value: AssetView; onChange: (v: AssetView) => void }) {
  const { t } = useTranslation()
  const VIEW_LABEL: Record<AssetView, string> = {
    grid: t('assets.viewGrid'),
    detail: t('assets.viewDetail'),
  }
  return (
    <div className="flex items-center gap-0.5 rounded-md border border-border bg-surface-1">
      {(['grid', 'detail'] as AssetView[]).map((v) => (
        <button
          key={v}
          type="button"
          title={VIEW_LABEL[v]}
          aria-pressed={value === v}
          onClick={() => onChange(v)}
          className={`flex h-5 w-7 items-center justify-center rounded transition-colors ${
            value === v ? 'bg-primary/15 text-primary' : 'text-text-secondary hover:text-text-primary'
          }`}
        >
          <Icon name={VIEW_ICON[v]} size={12} />
        </button>
      ))}
    </div>
  )
}



export function AssetCard({
  entry,
  onPreview,
  onDetail,
  onContext,
  onFavorite,
  onShowInFolder,
  onDelete,
}: {
  entry: LibraryEntry
  onPreview: () => void
  onDetail: () => void
  onContext: (x: number, y: number) => void
  /** 收藏切换（v0.4 E5）：⭐ tag 快捷打标/移除 */
  onFavorite?: (entry: LibraryEntry) => void
  onShowInFolder?: () => void
  onDelete?: () => void
}) {
  const { t } = useTranslation()
  const favorite = (entry.tags ?? []).includes('⭐')
  const ext = entry.kind === 'directory' ? null : (entry.name.split('.').pop() ?? '').toUpperCase()
  return (
    <div
      onContextMenu={(e) => {
        e.preventDefault()
        onContext(e.clientX, e.clientY)
      }}
      className="group flex flex-col rounded-md border border-transparent p-1.5 transition-[background-color,border-color,box-shadow] hover:border-border hover:bg-surface-1 hover:shadow-md"
    >
      {/* 图像区：图片/视频/音频直接预览；文件夹直接进入 */}
      <button
        type="button"
        onClick={onPreview}
        className={`relative flex h-24 w-full items-center justify-center overflow-hidden rounded-sm bg-surface-2 ${
          entry.kind === 'directory' ? 'cursor-pointer' : 'cursor-zoom-in'
        }`}
      >
        {entry.kind === 'image' ? (
          <img src={fileUrl(entry.path)} alt={entry.name} className="h-full w-full object-cover" loading="lazy" />
        ) : entry.thumb ? (
          <img src={fileUrl(entry.thumb)} alt={entry.name} className="h-full w-full object-cover" loading="lazy" />
        ) : (
          <Icon name={KIND_ICON[entry.kind]} size={26} className={kindIconTone(entry.kind)} />
        )}
        {(entry.kind === 'video' || entry.kind === 'audio') && (
          <span className="absolute inset-0 flex items-center justify-center bg-black/25 opacity-0 transition-opacity group-hover:opacity-100">
            <Icon name="play" size={26} className="text-white/90" />
          </span>
        )}
        {/* Tag 徽章（黑底白字，深浅主题通用） */}
        {(entry.tags ?? []).length > 0 && (
          <span className="absolute left-1 top-1 flex max-w-[90%] gap-1 overflow-hidden">
            {(entry.tags ?? []).slice(0, 2).map((tag) => (
              <span
                key={tag}
                className="truncate border border-white/20 bg-black/55 px-1.5 py-0.5 text-[9px] font-medium text-white backdrop-blur-sm"
              >
                {tag}
              </span>
            ))}
          </span>
        )}
        {/* 格式角标（黑底白字，深浅主题通用，对标 Heartstone 网格卡片右下角） */}
        {ext && (
          <span className="absolute bottom-1 right-1 border border-white/20 bg-black/55 px-1 py-0.5 text-[9px] font-medium text-white backdrop-blur-sm">
            {ext}
          </span>
        )}
        {/* 收藏星标（v0.4 E5）：hover 显示，已收藏常亮 */}
        {onFavorite && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onFavorite(entry)
            }}
            title={favorite ? '⭐' : '☆'}
            className={`absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full border backdrop-blur-sm transition-colors ${
              favorite
                ? 'border-warning/60 bg-warning/20 text-warning'
                : 'border-border bg-black/40 text-white/70 opacity-0 group-hover:opacity-100 hover:text-warning'
            }`}
          >
            <Icon name="tag" size={12} />
          </button>
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
      {/* 元数据行：恒占位保证卡片等高（directory 显示「文件夹」） */}
      <p className="mt-0.5 h-3.5 text-center text-[10px] text-text-disabled">
        {entry.kind === 'directory' ? t('assets.folder') : formatBytes(entry.size)}
      </p>
      {/* 底部操作行（渐进披露：hover 渐显；「打开」= 系统文件管理器查看，目录进入点卡片/名称） */}
      <div className="mt-1 flex items-center justify-center gap-1 border-t border-border pt-1 opacity-0 transition-opacity group-hover:opacity-100">
        {entry.kind === 'directory' ? (
          onShowInFolder && <MiniAction icon="folder" label={t('assets.open')} onClick={onShowInFolder} />
        ) : (
          <>
            {onShowInFolder && (
              <MiniAction icon="folder" label={t('assets.open')} onClick={onShowInFolder} />
            )}
            {onDelete && <MiniAction icon="trash" label={t('common.delete')} onClick={onDelete} tone="danger" />}
          </>
        )}
      </div>
    </div>
  )
}

interface AssetRowProps {
  entry: LibraryEntry
  onPreview: () => void
  onDetail: () => void
  onContext: (x: number, y: number) => void
  onShowInFolder?: () => void
  onDelete?: () => void
}

function MiniAction({
  icon,
  label,
  onClick,
  tone,
}: {
  icon: IconName
  label: string
  onClick: () => void
  tone?: 'danger'
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className={`flex h-6 items-center gap-1 rounded px-1.5 text-[10px] font-medium transition-colors ${
        tone === 'danger'
          ? 'text-error hover:bg-error/10'
          : 'text-text-secondary hover:bg-surface-2 hover:text-text-primary'
      }`}
    >
      <Icon name={icon} size={11} />
      {label}
    </button>
  )
}

// ---- 详情列表行（对标 Heartstone detail 模式：卡片式行 + 列对齐 + hover 渐显操作，管理表格）----
export function AssetDetailRow({ entry, onPreview, onDetail, onContext, onShowInFolder, onDelete }: AssetRowProps) {
  const { t } = useTranslation()
  return (
    <li
      onContextMenu={(e) => {
        e.preventDefault()
        onContext(e.clientX, e.clientY)
      }}
      className="group flex items-center gap-3 rounded-md border border-border bg-surface-1 px-3 py-2 transition-colors hover:border-primary/40"
    >
      <button
        type="button"
        onClick={onPreview}
        title={entry.name}
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-sm transition-opacity group-hover:opacity-80 ${kindIconBox(entry.kind)}`}
      >
        <Icon name={KIND_ICON[entry.kind]} size={14} />
      </button>
      <button
        type="button"
        onClick={onDetail}
        className="min-w-0 flex-1 truncate text-left text-sm text-text-primary"
        title={entry.name}
      >
        {entry.name}
      </button>
      {entry.kind !== 'directory' && (
        <span className="w-16 shrink-0 text-right text-[10px] text-text-secondary">{formatBytes(entry.size)}</span>
      )}
      <span className="w-20 shrink-0 text-right font-mono text-[10px] text-text-disabled">{formatMtime(entry.mtime)}</span>
      {/* 操作（渐进披露：hover 渐显；「打开」= 系统文件管理器查看，目录进入点图标/名称） */}
      <div className="flex w-24 shrink-0 items-center justify-end gap-2.5 opacity-0 transition-opacity group-hover:opacity-100">
        {entry.kind === 'directory' ? (
          onShowInFolder && (
            <button
              type="button"
              onClick={onShowInFolder}
              className="flex items-center gap-1 text-[10px] font-medium text-text-secondary transition-colors hover:text-primary"
            >
              <Icon name="folder" size={11} />
              {t('assets.open')}
            </button>
          )
        ) : (
          <>
            {onShowInFolder && (
              <button
                type="button"
                onClick={onShowInFolder}
                className="flex items-center gap-1 text-[10px] font-medium text-text-secondary transition-colors hover:text-primary"
              >
                <Icon name="folder" size={11} />
                {t('assets.open')}
              </button>
            )}
            {onDelete && (
              <button
                type="button"
                onClick={onDelete}
                className="flex items-center gap-1 text-[10px] font-medium text-error transition-colors hover:text-error/70"
              >
                <Icon name="trash" size={11} />
                {t('common.delete')}
              </button>
            )}
          </>
        )}
      </div>
    </li>
  )
}

// ---- 下载条：内联于素材视图（不弹窗），粘贴链接 → 解析 → 封面/格式 → 开始 ----
export function DownloadBar({
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
export function QuickPreview({ entry, onClose }: { entry: LibraryEntry | null; onClose: () => void }) {
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

export function DocumentText({ path }: { path: string }) {
  const { t } = useTranslation()
  const { data } = useQuery({
    queryKey: ['asset-doc', path],
    queryFn: () => api.getText<string>(`/api/library/file?path=${encodeURIComponent(path)}`),
    enabled: !!path,
  })
  if (data === undefined) {
    return <div className="flex h-40 items-center justify-center"><Spinner /></div>
  }
  return (
    <div className="flex w-full flex-col">
      <div className="mb-1 flex items-center justify-end">
        <CopyButton text={data} label={t('common.copy')} />
      </div>
      <pre className="max-h-[65vh] w-full overflow-auto whitespace-pre-wrap p-3 font-mono text-xs leading-relaxed text-text-primary">
        {data.slice(0, 30000)}
      </pre>
    </div>
  )
}

// ---- 预览浮层 ----
export function PreviewOverlay({
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
  const [noteDraft, setNoteDraft] = useState<string | null>(null)
  const [noteSaving, setNoteSaving] = useState(false)
  const toast = useToast()

  useEffect(() => {
    setTextContent(null)
    setNoteDraft(null)
    if (!preview || preview.kind !== 'document') return
    void api
      .getText<string>(`/api/library/file?path=${encodeURIComponent(preview.path)}`)
      .then(setTextContent)
      .catch(() => setTextContent(null))
  }, [preview])
  // 笔记初值：info（含 note）优先，其次 preview 透传
  useEffect(() => {
    setNoteDraft(null)
  }, [preview?.path])

  const meta = info.data?.media
  const savedNote = info.data?.note ?? preview?.note ?? null
  const noteValue = noteDraft ?? savedNote ?? ''

  // 片段标记（v0.26）：info/snippets 优先，preview 透传兜底
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null)
  const [snippets, setSnippets] = useState<AssetSnippet[] | null>(null)
  const [snipT0, setSnipT0] = useState('')
  const [snipT1, setSnipT1] = useState('')
  const [snipLabel, setSnipLabel] = useState('')
  const [snipSaving, setSnipSaving] = useState(false)
  useEffect(() => {
    setSnippets(null)
    setSnipT0('')
    setSnipT1('')
    setSnipLabel('')
  }, [preview?.path])
  const savedSnippets = snippets ?? info.data?.snippets ?? preview?.snippets ?? []
  const isTimedMedia = preview?.kind === 'video' || preview?.kind === 'audio'

  function captureTime(which: 't0' | 't1') {
    const cur = mediaRef.current?.currentTime
    if (cur === undefined || Number.isNaN(cur)) return
    const v = cur.toFixed(1)
    if (which === 't0') setSnipT0(v)
    else setSnipT1(v)
  }
  function seekTo(t: number) {
    const m = mediaRef.current
    if (!m) return
    m.currentTime = t
    void m.play().catch(() => {})
  }
  async function persistSnippets(next: AssetSnippet[]) {
    if (!preview) return
    setSnipSaving(true)
    try {
      const res = await api.post<{ snippets: AssetSnippet[] }>('/api/library/snippets', {
        path: preview.path,
        snippets: next,
      })
      setSnippets(res.snippets)
      preview.snippets = res.snippets
      toast(t('library.snippetsSaved', '片段已保存'), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setSnipSaving(false)
    }
  }
  function addSnippet() {
    const t0 = parseFloat(snipT0)
    const t1 = parseFloat(snipT1)
    if (Number.isNaN(t0) || Number.isNaN(t1) || t1 <= t0 || t0 < 0) {
      toast(t('library.snippetInvalid', '时间非法：需 0≤起点<终点'), 'warning')
      return
    }
    void persistSnippets([...savedSnippets, { t0, t1, label: snipLabel.trim() }])
    setSnipT0('')
    setSnipT1('')
    setSnipLabel('')
  }
  function removeSnippet(idx: number) {
    void persistSnippets(savedSnippets.filter((_, i) => i !== idx))
  }

  async function saveNote() {
    if (!preview) return
    setNoteSaving(true)
    try {
      const res = await api.post<{ note: string | null }>('/api/library/note', {
        path: preview.path,
        note: noteValue,
      })
      setNoteDraft(null)
      preview.note = res.note
      toast(t('library.noteSaved', '笔记已保存'), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setNoteSaving(false)
    }
  }

  return (
    <Modal open={!!preview} onClose={onClose} width={760} title={preview?.name}>
      {preview && (
        <div className="flex gap-4">
          <div className="flex min-w-0 flex-1 items-center justify-center bg-surface-2 p-2">
            {preview.kind === 'image' && (
              <img src={fileUrl(preview.path)} alt={preview.name} className="max-h-96 max-w-full object-contain" />
            )}
            {preview.kind === 'video' && (
              <video
                ref={mediaRef as React.Ref<HTMLVideoElement>}
                src={fileUrl(preview.path)}
                controls
                className="max-h-96 max-w-full"
              />
            )}
            {preview.kind === 'audio' && (
              <audio
                ref={mediaRef as React.Ref<HTMLAudioElement>}
                src={fileUrl(preview.path)}
                controls
                className="w-full"
              />
            )}
            {preview.kind === 'document' &&
              (textContent ? (
                <div className="flex w-full flex-col">
                  <div className="mb-1 flex items-center justify-end pr-1">
                    <CopyButton text={textContent} label={t('common.copy')} />
                  </div>
                  <pre className="max-h-96 w-full overflow-auto whitespace-pre-wrap p-3 font-mono text-xs text-text-primary">
                    {textContent.slice(0, 20000)}
                  </pre>
                </div>
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
              <div>
                <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-text-secondary">
                  {t('library.note', '笔记')}
                </h4>
                <textarea
                  className="min-h-[64px] w-full resize-y rounded border border-border bg-surface-1 px-2 py-1 text-xs text-text-primary outline-none focus:border-primary"
                  placeholder={t('library.notePlaceholder', '记录技法/灵感…')}
                  value={noteValue}
                  onChange={(e) => setNoteDraft(e.target.value)}
                />
                {(noteDraft !== null) && (
                  <Button size="sm" loading={noteSaving} onClick={() => void saveNote()} className="mt-1">
                    {t('common.save', '保存')}
                  </Button>
                )}
              </div>
              {isTimedMedia && (
                <div>
                  <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-text-secondary">
                    {t('library.snippets', '片段')} · {savedSnippets.length}
                  </h4>
                  {savedSnippets.length > 0 && (
                    <ul className="mb-1.5 max-h-28 space-y-1 overflow-y-auto">
                      {savedSnippets.map((s, i) => (
                        <li key={i} className="group flex items-center gap-1 text-xs">
                          <button
                            type="button"
                            onClick={() => seekTo(s.t0)}
                            className="min-w-0 flex-1 truncate text-left text-text-primary hover:text-primary"
                            title={`${s.t0}s → ${s.t1}s`}
                          >
                            <span className="font-mono text-[10px] text-text-disabled">
                              {s.t0}s-{s.t1}s
                            </span>{' '}
                            {s.label || t('library.snippetUntitled', '未命名片段')}
                          </button>
                          <button
                            type="button"
                            onClick={() => removeSnippet(i)}
                            className="shrink-0 text-text-disabled opacity-0 hover:text-error group-hover:opacity-100"
                            title={t('common.delete')}
                          >
                            <Icon name="close" size={11} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="flex items-center gap-1">
                    <input
                      value={snipT0}
                      onChange={(e) => setSnipT0(e.target.value)}
                      placeholder="t0"
                      inputMode="decimal"
                      className="w-14 rounded border border-border bg-surface-1 px-1 py-0.5 font-mono text-[11px] outline-none focus:border-primary"
                    />
                    <input
                      value={snipT1}
                      onChange={(e) => setSnipT1(e.target.value)}
                      placeholder="t1"
                      inputMode="decimal"
                      className="w-14 rounded border border-border bg-surface-1 px-1 py-0.5 font-mono text-[11px] outline-none focus:border-primary"
                    />
                    <button
                      type="button"
                      onClick={() => captureTime('t0')}
                      className="rounded border border-border px-1 py-0.5 text-[10px] text-text-secondary hover:border-primary hover:text-primary"
                      title={t('library.captureT0', '取当前为起点')}
                    >
                      ▸0
                    </button>
                    <button
                      type="button"
                      onClick={() => captureTime('t1')}
                      className="rounded border border-border px-1 py-0.5 text-[10px] text-text-secondary hover:border-primary hover:text-primary"
                      title={t('library.captureT1', '取当前为终点')}
                    >
                      ▸1
                    </button>
                  </div>
                  <div className="mt-1 flex items-center gap-1">
                    <input
                      value={snipLabel}
                      onChange={(e) => setSnipLabel(e.target.value)}
                      placeholder={t('library.snippetLabel', '这个转场不错…')}
                      className="min-w-0 flex-1 rounded border border-border bg-surface-1 px-1.5 py-0.5 text-xs outline-none focus:border-primary"
                    />
                    <Button size="sm" loading={snipSaving} onClick={addSnippet}>
                      +
                    </Button>
                  </div>
                </div>
              )}
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

export function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-text-disabled">{label}</dt>
      <dd className="truncate text-text-primary">{value}</dd>
    </div>
  )
}
