/** 作业：历史列表 + 详情（状态/阶段/事件/旁白试听）+ 运行控制。 */

import { createElement, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import '@hyperframes/player'

import { API_BASE, monolineApi, type MonolineEvent } from '../../api'
import { Badge, Button, Card, EmptyState, Spinner, useToast, type BadgeTone } from '../../components/ui'
import { useEventSource } from '../../hooks/useEventSource'
import { BeatsEditor } from './BeatsEditor'

const STATUS_TONE: Record<string, BadgeTone> = {
  succeeded: 'success',
  failed: 'error',
  running: 'primary',
  queued: 'warning',
  cancelled: 'warning',
  draft: 'neutral',
}

export function JobsTab({ selectedId, onSelect }: { selectedId: string | null; onSelect: (id: string | null) => void }) {
  const { t } = useTranslation()
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['monoline-jobs'],
    queryFn: () => monolineApi.list(50),
  })
  const jobs = data?.jobs ?? []

  return (
    <div className="flex h-full min-h-0 gap-3">
      <div className="flex w-72 shrink-0 flex-col gap-2 overflow-y-auto">
        <div className="flex items-center justify-between">
          <span className="text-xs text-text-secondary">{t('monoline.jobs', { n: jobs.length })}</span>
          <Button size="sm" variant="ghost" onClick={() => refetch()}>{t('common.refresh')}</Button>
        </div>
        {isLoading && <Spinner />}
        {!isLoading && jobs.length === 0 && <EmptyState title={t('common.empty')} description={t('monoline.jobsEmpty')} />}
        {jobs.map((j) => (
          <Card
            key={j.id}
            className={`cursor-pointer ${selectedId === j.id ? 'border-primary' : ''}`}
            padded
          >
            <div onClick={() => onSelect(j.id)} className="flex gap-2">
              <img
                src={monolineApi.fileUrl(j.id, 'renders/poster.jpg')}
                alt=""
                className="h-12 w-20 shrink-0 border border-border object-cover"
                onError={(e) => {
                  ;(e.target as HTMLImageElement).style.display = 'none'
                }}
              />
              <div className="flex min-w-0 flex-col gap-1">
                <div className="truncate text-sm text-text-primary">{j.title || t('monoline.untitled')}</div>
                <div className="flex items-center gap-2">
                  <Badge tone={STATUS_TONE[j.status] ?? 'neutral'}>{j.status}</Badge>
                  {j.total_duration != null && (
                    <span className="font-mono text-[11px] text-text-disabled">{j.total_duration.toFixed(1)}s</span>
                  )}
                </div>
              </div>
            </div>
          </Card>
        ))}
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto">
        {selectedId ? (
          <JobDetail key={selectedId} jobId={selectedId} onDeleted={() => { onSelect(null); refetch() }} />
        ) : (
          <EmptyState title={t('monoline.pickJob')} description={t('monoline.pickJobHint')} />
        )}
      </div>
    </div>
  )
}

function Player({ src, aspect }: { src: string; aspect?: string }) {
  // hyperframes-player 为自定义元素：src 经 attribute 设置；composition 内 <audio id=vo>
  // 在纯静态预览下不会被 player 接管，ready 后把音频代理到父帧使其可听（上游同修复）。
  const ref = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const el = ref.current as unknown as HTMLElement & {
      setAttribute(k: string, v: string): void
      addEventListener(t: string, fn: () => void): void
      removeEventListener(t: string, fn: () => void): void
      ready?: boolean
    } | null
    if (el) el.setAttribute('src', src)
  }, [src])
  useEffect(() => {
    const el = ref.current as unknown as {
      iframeElement?: HTMLIFrameElement
      shadowRoot?: ShadowRoot
      setAttribute(k: string, v: string): void
      addEventListener(t: string, fn: () => void): void
      removeEventListener(t: string, fn: () => void): void
      ready?: boolean
      _promoteToParentProxy?: () => void
    } | null
    if (!el) return
    let done = false
    const promote = () => {
      if (done) return
      try {
        const f = el.iframeElement ?? el.shadowRoot?.querySelector('iframe')
        const a = f?.contentDocument?.getElementById('vo') as HTMLAudioElement | null
        const url = a?.currentSrc || a?.src
        if (url) el.setAttribute('audio-src', url)
        if (typeof el._promoteToParentProxy === 'function') {
          el._promoteToParentProxy()
          done = true
        }
      } catch {
        /* 预览静音也不崩 */
      }
    }
    const onReady = () => promote()
    el.addEventListener('ready', onReady)
    if (el.ready) promote()
    return () => el.removeEventListener('ready', onReady)
  }, [src])
  return createElement('hyperframes-player', {
    ref,
    controls: true,
    style: {
      width: '100%',
      height: 'auto',
      display: 'block',
      background: '#000',
      ...(aspect ? { aspectRatio: aspect } : {}),
    },
  } as unknown as Record<string, unknown>)
}

function BgmCard({ jobId, bgm, onChanged }: {
  jobId: string
  bgm?: { src?: string; volume?: number; duck?: boolean }
  onChanged: () => void
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const [volume, setVolume] = useState(typeof bgm?.volume === 'number' ? bgm.volume : 0.22)
  const [duck, setDuck] = useState(bgm?.duck !== false)
  return (
    <Card>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs text-text-secondary">
          {t('monoline.bgm')}{bgm?.src ? ` · ${bgm.src.split('/').pop()}` : ''}
        </span>
        <span className="flex items-center gap-1">
          <label className="flex items-center gap-1 text-[11px] text-text-secondary" title={t('monoline.bgmVolume')}>
            {t('monoline.bgmVolume')}
            <input
              type="range"
              min={0}
              max={0.6}
              step={0.02}
              value={volume}
              onChange={(e) => setVolume(Number(e.target.value))}
              className="w-20"
            />
            <span className="font-mono">{volume.toFixed(2)}</span>
          </label>
          <label className="flex cursor-pointer items-center gap-1 text-[11px] text-text-secondary">
            <input type="checkbox" checked={duck} onChange={(e) => setDuck(e.target.checked)} />
            {t('monoline.bgmDuck')}
          </label>
          <label className="flex h-7 cursor-pointer items-center px-3 text-xs text-text-secondary hover:bg-surface-2 hover:text-text-primary">
            {t('monoline.bgmUpload')}
            <input
              type="file"
              accept=".mp3,.wav,.m4a,.ogg,.flac"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0]
                e.target.value = ''
                if (!f) return
                try {
                  await monolineApi.uploadBgm(jobId, f, volume, duck)
                  toast(t('monoline.bgmOk'), 'success')
                  onChanged()
                } catch (err) {
                  toast(err instanceof Error ? err.message : String(err), 'error')
                }
              }}
            />
          </label>
          {bgm?.src && (
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                await monolineApi.removeBgm(jobId)
                onChanged()
              }}
            >
              {t('monoline.bgmRemove')}
            </Button>
          )}
        </span>
      </div>
      <p className="text-[11px] text-text-disabled">{t('monoline.bgmHint')}</p>
    </Card>
  )
}

function JobDetail({ jobId, onDeleted }: { jobId: string; onDeleted: () => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const queryClient = useQueryClient()
  const [events, setEvents] = useState<MonolineEvent[]>([])
  const { data: job, refetch } = useQuery({
    queryKey: ['monoline-job', jobId],
    queryFn: () => monolineApi.get(jobId),
    refetchInterval: 3000,
  })

  const loadEvents = async () => {
    try {
      const r = await monolineApi.events(jobId, 200)
      setEvents(r.events)
    } catch {
      /* 忽略轮询失败 */
    }
  }
  useEffect(() => {
    loadEvents()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId])

  // 运行中时订阅单作业 SSE 做实时刷新
  useEventSource(job?.status === 'running' || job?.status === 'queued' ? monolineApi.jobStreamUrl(jobId) : null, () => {
    refetch()
    loadEvents()
  })

  if (!job) return <Spinner />
  const audioUrl = monolineApi.fileUrl(jobId, 'composition/audio/narration.wav')
  const canvas = (job.canvas ?? {}) as { width?: number; height?: number }
  const cw = Number(canvas.width) || 1920
  const ch = Number(canvas.height) || 1080
  const mp4Url = `${API_BASE}/api/monoline/jobs/${jobId}/download`
  const posterUrl = `${API_BASE}/api/monoline/jobs/${jobId}/poster`

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={STATUS_TONE[job.status] ?? 'neutral'}>{job.status}</Badge>
        {job.total_duration != null && <span className="font-mono text-xs">{job.total_duration.toFixed(1)}s</span>}
        {job.error && <span className="text-xs text-error">{job.error}</span>}
        <span className="ml-auto flex gap-1">
          <Button
            size="sm"
            onClick={async () => {
              try {
                await monolineApi.run(jobId)
                toast(t('monoline.runQueued'), 'success')
                refetch()
              } catch (e) {
                toast(e instanceof Error ? e.message : String(e), 'error')
              }
            }}
          >
            {t('monoline.run')}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={async () => {
              await monolineApi.cancel(jobId)
              refetch()
            }}
          >
            {t('common.cancel')}
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={async () => {
              try {
                await monolineApi.remove(jobId)
                queryClient.invalidateQueries({ queryKey: ['monoline-jobs'] })
                onDeleted()
              } catch (e) {
                toast(e instanceof Error ? e.message : String(e), 'error')
              }
            }}
          >
            {t('common.delete')}
          </Button>
        </span>
      </div>
      {job.status === 'succeeded' && (
        <Card>
          <div className="mb-1 text-xs text-text-secondary">{t('monoline.narration')}</div>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <audio controls src={audioUrl} className="w-full" />
        </Card>
      )}
      <BgmCard jobId={jobId} bgm={job.config?.bgm as { src?: string } | undefined} onChanged={refetch} />
      {(job.stages ?? []).some((s) => s.key === 'plan' && s.status === 'succeeded') && (
        <BeatsEditor jobId={jobId} onChanged={refetch} />
      )}
      {(job.stages ?? []).some((s) => s.key === 'compose' && s.status === 'succeeded') && (
        <Card>
          <div className="mb-1 text-xs text-text-secondary">{t('monoline.preview')}</div>
          <Player src={monolineApi.fileUrl(jobId, 'composition/index.html')} aspect={`${cw} / ${ch}`} />
        </Card>
      )}
      {(job.stages ?? []).some((s) => s.key === 'deliver' && s.status === 'succeeded') && (
        <Card>
          <div className="mb-2 text-xs text-text-secondary">{t('monoline.watch')}</div>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video controls preload="metadata" poster={posterUrl} src={mp4Url} className="w-full bg-black" />
        </Card>
      )}
      {(job.stages ?? []).some((s) => s.key === 'deliver' && s.status === 'succeeded') && (
        <Card>
          <div className="mb-2 text-xs text-text-secondary">{t('monoline.downloads')}</div>
          <div className="flex flex-wrap gap-2 text-sm">
            <a className="text-primary hover:underline" href={mp4Url}>
              MP4
            </a>
            <a className="text-primary hover:underline" href={`${API_BASE}/api/monoline/jobs/${jobId}/subtitles?fmt=srt`}>
              SRT
            </a>
            <a className="text-primary hover:underline" href={`${API_BASE}/api/monoline/jobs/${jobId}/subtitles?fmt=vtt`}>
              VTT
            </a>
            <a className="text-primary hover:underline" href={`${API_BASE}/api/monoline/jobs/${jobId}/poster`} target="_blank" rel="noreferrer">
              {t('monoline.poster')}
            </a>
          </div>
        </Card>
      )}
      <Card>
        <div className="mb-2 text-xs text-text-secondary">{t('monoline.stages')}</div>
        <div className="flex flex-col gap-1">
          {(job.stages ?? []).map((s) => (
            <div key={s.key} className="flex items-center gap-2 font-mono text-xs">
              <span className="w-20 text-text-primary">{s.key}</span>
              <Badge tone={s.status === 'succeeded' ? 'success' : s.status === 'failed' ? 'error' : 'neutral'}>
                {s.status}
              </Badge>
              {s.duration_ms != null && <span className="text-text-disabled">{s.duration_ms}ms</span>}
              {s.error && <span className="truncate text-error">{s.error}</span>}
            </div>
          ))}
          {(job.stages ?? []).length === 0 && <span className="text-xs text-text-disabled">—</span>}
        </div>
      </Card>
      <Card>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs text-text-secondary">{t('monoline.events')}</span>
          <Button size="sm" variant="ghost" onClick={loadEvents}>{t('common.refresh')}</Button>
        </div>
        <div className="flex max-h-64 flex-col gap-1 overflow-y-auto font-mono text-[11px]">
          {events.slice(-80).map((e, i) => (
            <div key={i} className={e.level === 'error' ? 'text-error' : e.level === 'warn' ? 'text-text-secondary' : 'text-text-disabled'}>
              [{e.stage_key ?? '-'}] {e.message ?? e.kind}
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}
