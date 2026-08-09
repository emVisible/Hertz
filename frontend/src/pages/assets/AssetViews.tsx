import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { useDownloadStore } from '../../stores/download'
import type { DownloadTask } from '../../api/download'

import { api, fileUrl, type FileInfo, type LibraryEntry, type ParseResult } from '../../api'
import { Badge, Button, CopyButton, Icon, Modal, Select, Spinner, useToast, type IconName } from '../../components/ui'

const KIND_ICON: Record<string, IconName> = {
  video: 'studio',
  audio: 'console',
  image: 'library',
  document: 'briefs',
  directory: 'folder',
  other: 'more',
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



export function AssetCard({
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
      className="group flex flex-col rounded-md border border-transparent p-1.5 transition-[background-color,border-color,box-shadow] hover:border-border hover:bg-surface-1 hover:shadow-sm"
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
