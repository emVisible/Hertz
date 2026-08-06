import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { api, type ParseResult } from '../api'
import { useDownloadStore } from '../stores/download'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Icon,
  Input,
  Progress,
  Select,
  useToast,
} from '../components/ui'
import { useEventSource } from '../hooks/useEventSource'
import type { DownloadStatus, DownloadTask } from '../api/download'

const STATUS_TONE: Record<DownloadStatus, 'neutral' | 'success' | 'warning' | 'error' | 'primary'> = {
  pending: 'neutral',
  downloading: 'primary',
  completed: 'success',
  failed: 'error',
  cancelled: 'warning',
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

export function DownloadsPage() {
  const { t } = useTranslation()
  const toast = useToast()
  const tasks = useDownloadStore((s) => s.tasks)
  const upsert = useDownloadStore((s) => s.upsert)
  const setAll = useDownloadStore((s) => s.setAll)

  const [url, setUrl] = useState('')
  const [parsing, setParsing] = useState(false)
  const [parseResult, setParseResult] = useState<ParseResult | null>(null)
  const [parseError, setParseError] = useState<string | null>(null)
  const [formatId, setFormatId] = useState('')
  const [selectedAssets, setSelectedAssets] = useState<Set<string>>(new Set())

  const { data: initialTasks } = useQuery({
    queryKey: ['download-tasks'],
    queryFn: () => api.get<DownloadTask[]>('/api/download/tasks'),
  })

  // queryFn 保持纯净：历史任务经 effect 装入 store，避免 setState-in-query
  // 的反模式（AXIOM §22.2 数据流单向）。
  useEffect(() => {
    if (initialTasks) setAll(initialTasks)
  }, [initialTasks, setAll])

  useEventSource(`${api_base()}/api/download/tasks/events`, (ev) => {
    const data = JSON.parse(ev.data) as { event: string; task: DownloadTask }
    upsert(data.task)
  })

  async function handleParse() {
    if (!url.trim()) return
    setParsing(true)
    setParseError(null)
    setParseResult(null)
    try {
      const result = await api.get<ParseResult>(`/api/download/parse?url=${encodeURIComponent(url.trim())}`)
      setParseResult(result)
      if (result.formats?.length) setFormatId(result.formats[0].format_id)
      if (result.assets?.length) setSelectedAssets(new Set(result.assets.map((a) => a.url)))
    } catch (err) {
      setParseError(err instanceof Error ? err.message : String(err))
    } finally {
      setParsing(false)
    }
  }

  async function startFromUrl() {
    const target = parseResult
    if (!target) return
    try {
      if (target.kind === 'page' && target.assets) {
        for (const asset of target.assets) {
          if (selectedAssets.has(asset.url)) {
            const task = await api.post<DownloadTask>('/api/download/tasks', { url: asset.url })
            await api.post(`/api/download/tasks/${task.id}/start`)
            upsert(task)
          }
        }
      } else {
        const task = await api.post<DownloadTask>('/api/download/tasks', { url: url.trim() })
        await api.post(`/api/download/tasks/${task.id}/start`, { format_id: formatId || undefined })
        upsert(task)
      }
      toast(t('download.started'), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  async function action(taskId: string, kind: 'cancel' | 'retry' | 'delete') {
    try {
      if (kind === 'cancel') {
        const task = await api.post<DownloadTask>(`/api/download/tasks/${taskId}/cancel`)
        upsert(task)
      } else if (kind === 'retry') {
        const task = await api.post<DownloadTask>(`/api/download/tasks/${taskId}/retry`)
        upsert(task)
      } else {
        await api.delete(`/api/download/tasks/${taskId}`)
        useDownloadStore.getState().remove(taskId)
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const running = useMemo(() => tasks.filter((t) => t.status === 'downloading').length, [tasks])

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto p-4">
      <Card className="shrink-0">
        <div className="flex gap-2">
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={t('download.urlPlaceholder')}
            className="flex-1"
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleParse()
            }}
          />
          <Button onClick={handleParse} loading={parsing}>
            {t('download.parse')}
          </Button>
        </div>
        {parseError && <p className="mt-2 text-xs text-error">{parseError}</p>}

        {parseResult && (
          <div className="mt-4">
            {parseResult.kind === 'page' ? (
              <div>
                <p className="mb-2 text-sm font-medium">
                  {t('download.assetsFound', { count: parseResult.assets?.length ?? 0 })}
                </p>
                {parseResult.assets?.length ? (
                  <ul className="max-h-48 space-y-1 overflow-auto">
                    {parseResult.assets.map((a) => (
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
                ) : (
                  <p className="text-xs text-text-disabled">{t('download.noAssets')}</p>
                )}
              </div>
            ) : (
              <div className="flex flex-wrap items-end gap-4">
                <div>
                  <p className="mb-1 text-sm font-semibold">{parseResult.title}</p>
                  <p className="mb-2 text-xs text-text-secondary">
                    {parseResult.uploader && `${t('download.uploader')}: ${parseResult.uploader} · `}
                    {`${t('download.duration')}: ${formatDuration(parseResult.duration)}`}
                  </p>
                  {parseResult.formats && parseResult.formats.length > 0 && (
                    <Select
                      label={t('download.format')}
                      value={formatId}
                      onChange={(e) => setFormatId(e.target.value)}
                      options={parseResult.formats.map((f) => ({
                        value: f.format_id,
                        label: `${f.label}${f.filesize ? ` · ${formatBytes(f.filesize)}` : ''}`,
                      }))}
                    />
                  )}
                </div>
                <Button onClick={startFromUrl}>
                  <Icon name="downloads" size={14} />
                  {t('download.start')}
                </Button>
              </div>
            )}
          </div>
        )}
      </Card>

      <Card padded={false} className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-border px-4 py-2">
          <h2 className="text-sm font-semibold">
            {t('download.taskList')}
            {running > 0 && (
              <span className="ml-2 text-xs font-normal text-text-secondary">
                {running} 个任务进行中
              </span>
            )}
          </h2>
        </div>
        {tasks.length === 0 ? (
          <EmptyState icon="downloads" title={t('download.noTasks')} />
        ) : (
          <ul className="divide-y divide-border overflow-auto">
            {tasks.map((task) => (
              <li key={task.id} className="flex items-center gap-3 px-4 py-3">
                <Badge tone={STATUS_TONE[task.status]}>{t(`download.status.${task.status}`)}</Badge>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-text-primary" title={task.url}>
                    {task.url}
                  </p>
                  <div className="mt-1 flex items-center gap-2">
                    <Progress value={task.status === 'downloading' ? task.progress : task.status === 'completed' ? 100 : task.progress} className="max-w-64" />
                    <span className="text-xs text-text-secondary">
                      {task.status === 'downloading'
                        ? `${formatBytes(task.downloaded_bytes)} / ${formatBytes(task.total_bytes)}`
                        : task.status === 'failed'
                          ? task.error
                          : formatBytes(task.total_bytes)}
                    </span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {task.status === 'downloading' && (
                    <Button size="sm" variant="ghost" onClick={() => action(task.id, 'cancel')}>
                      {t('download.actions.cancel')}
                    </Button>
                  )}
                  {task.status === 'failed' && (
                    <Button size="sm" variant="ghost" onClick={() => action(task.id, 'retry')}>
                      {t('download.actions.retry')}
                    </Button>
                  )}
                  {task.status === 'completed' && task.file_path && window.electron && (
                    <Button size="sm" variant="ghost" onClick={() => window.electron?.showItemInFolder(task.file_path!)}>
                      {t('common.showInFolder')}
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => action(task.id, 'delete')}>
                    {t('download.actions.delete')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

function api_base(): string {
  return (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:8787'
}
