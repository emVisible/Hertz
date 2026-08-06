import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { api, fileUrl } from '../api'
import { Button, EmptyState, Icon, Modal, Spinner, type IconName } from '../components/ui'
import type { FileInfo, LibraryEntry } from '../api'

interface RootsTree {
  base: string
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

function formatDate(ts: number): string {
  return new Date(ts * 1000).toLocaleString()
}

function formatDuration(seconds?: number | null): string {
  if (!seconds) return '—'
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

const KIND_ICON: Record<string, IconName> = {
  video: 'studio',
  audio: 'console',
  image: 'library',
  document: 'briefs',
  directory: 'folder',
  other: 'more',
}

export function LibraryPage() {
  const { t } = useTranslation()
  const [currentPath, setCurrentPath] = useState<string | null>(null)
  const [preview, setPreview] = useState<FileInfo | null>(null)

  const roots = useQuery({
    queryKey: ['library-roots'],
    queryFn: () => api.get<RootsTree>('/api/library/roots'),
  })

  const scan = useQuery({
    queryKey: ['library-scan', currentPath],
    queryFn: () => api.get<{ path: string; entries: LibraryEntry[] }>(`/api/library/scan?path=${encodeURIComponent(currentPath!)}`),
    enabled: !!currentPath,
  })

  const info = useQuery({
    queryKey: ['library-info', preview?.path],
    queryFn: () => api.get<FileInfo>(`/api/library/info?path=${encodeURIComponent(preview!.path)}`),
    enabled: !!preview,
  })

  const entries = scan.data?.entries ?? []
  const meta = info.data?.media

  return (
    <div className="flex h-full">
      {/* Folder tree sidebar */}
      <aside className="w-52 shrink-0 overflow-auto border-r border-border bg-surface-1 p-2">
        <p className="px-2 pb-2 pt-1 text-xs font-medium text-text-secondary">Projects</p>
        {roots.data?.tree.map((node) => (
          <FolderNode key={node.path} node={node} onOpen={setCurrentPath} />
        ))}
        {roots.data && roots.data.tree.length === 0 && (
          <p className="px-2 text-xs text-text-disabled">data/projects 为空</p>
        )}
      </aside>

      {/* Grid */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-border px-4 py-2">
          <Icon name="folder" size={14} className="text-text-secondary" />
          <span className="truncate text-sm text-text-secondary">{currentPath ?? roots.data?.base ?? '—'}</span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => scan.refetch()}
            disabled={!currentPath || scan.isFetching}
          >
            <Icon name="console" size={12} />
            {t('common.refresh')}
          </Button>
        </div>

        <div className="flex-1 overflow-auto p-4">
          {scan.isLoading ? (
            <div className="flex h-full items-center justify-center">
              <Spinner />
            </div>
          ) : entries.length === 0 ? (
            <EmptyState icon="library" title={t('library.noEntries')} />
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3">
              {entries.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  onClick={() => {
                    if (entry.kind === 'directory') setCurrentPath(entry.path)
                    else setPreview({ ...entry })
                  }}
                  className="group flex flex-col items-center gap-1.5 rounded-lg border border-transparent p-2 transition-colors hover:border-border hover:bg-surface-1"
                >
                  <div className="flex h-20 w-full items-center justify-center overflow-hidden rounded-md bg-surface-2">
                    {entry.kind === 'image' ? (
                      <img src={fileUrl(entry.path)} alt={entry.name} className="h-full w-full object-cover" loading="lazy" />
                    ) : entry.thumb ? (
                      <img src={fileUrl(entry.thumb)} alt={entry.name} className="h-full w-full object-cover" loading="lazy" />
                    ) : (
                      <Icon name={KIND_ICON[entry.kind]} size={28} className="text-text-disabled" />
                    )}
                    {entry.kind === 'video' && !entry.thumb && (
                      <Icon name="studio" size={28} className="absolute text-white/70" />
                    )}
                  </div>
                  <p className="w-full truncate text-center text-xs text-text-secondary">{entry.name}</p>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Preview modal */}
      <Modal open={!!preview} onClose={() => setPreview(null)} width={720} title={preview?.name}>
        {preview && (
          <div className="flex gap-4">
            <div className="flex min-w-0 flex-1 items-center justify-center rounded-md bg-surface-2 p-2">
              {preview.kind === 'image' && (
                <img src={fileUrl(preview.path)} alt={preview.name} className="max-h-80 max-w-full rounded object-contain" />
              )}
              {preview.kind === 'video' && (
                <video src={fileUrl(preview.path)} controls className="max-h-80 max-w-full rounded" />
              )}
              {preview.kind === 'audio' && (
                <audio src={fileUrl(preview.path)} controls className="w-full" />
              )}
              {preview.kind === 'document' && (
                <div className="flex flex-col items-center gap-2 py-8 text-text-disabled">
                  <Icon name="briefs" size={32} />
                  <span className="text-xs">{t('library.noPreview')}</span>
                </div>
              )}
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
                  <MetaRow label={t('library.meta.modified')} value={formatDate(info.data?.mtime ?? preview.mtime)} />
                  {meta?.codec && <MetaRow label={t('library.meta.codec')} value={meta.codec} />}
                  {meta?.width && meta.height && (
                    <MetaRow label={t('library.meta.resolution')} value={`${meta.width}×${meta.height}`} />
                  )}
                  {meta?.duration && <MetaRow label={t('library.meta.duration')} value={formatDuration(meta.duration)} />}
                  {meta?.bitrate && <MetaRow label={t('library.meta.bitrate')} value={`${formatBytes(meta.bitrate)}/s`} />}
                </dl>
              )}
              {window.electron && (
                <Button size="sm" variant="secondary" className="mt-3" onClick={() => window.electron?.showItemInFolder(preview.path)}>
                  {t('library.openInFolder')}
                </Button>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}

interface TreeEntry {
  name: string
  path: string
  children: TreeEntry[]
}

function FolderNode({
  node,
  onOpen,
  depth = 0,
}: {
  node: TreeEntry
  onOpen: (path: string) => void
  depth?: number
}) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button
        type="button"
        onClick={() => {
          setOpen((o) => !o)
          onOpen(node.path)
        }}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
        style={{ paddingLeft: 8 + depth * 12 }}
      >
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} className="transition-transform" />
        <span className="truncate">{node.name}</span>
      </button>
      {open && node.children?.map((child) => <FolderNode key={child.path} node={child} onOpen={onOpen} depth={depth + 1} />)}
    </div>
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
