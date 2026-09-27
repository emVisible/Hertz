/** Monoline 融合域 API：文稿转解说视频作业（/api/monoline/*）。 */

import { api, API_BASE } from './client'

export interface MonolineJob {
  id: string
  slug: string | null
  title: string | null
  status: 'draft' | 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  script_text: string
  config: Record<string, unknown>
  canvas: Record<string, unknown>
  total_duration: number | null
  error: string | null
  created_at: string | null
  started_at: string | null
  finished_at: string | null
  stages?: MonolineStage[]
}

export interface MonolineStage {
  key: string
  seq: number
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped'
  input_hash: string | null
  output_json: Record<string, unknown> | null
  duration_ms: number | null
  error: string | null
}

export interface OutlineEntry {
  i: number
  text: string
  kind: string
  source: string
  section: string
  image: string
  images: string[]
  seconds: number
}

export interface OutlineView {
  entries: OutlineEntry[]
  beats: number
  est_seconds: number
  sections: string[]
  pinned?: number
  imaged?: number
  version?: number
}

export interface MonolineEvent {
  kind: string
  stage_key: string | null
  level: string
  message: string | null
  data: Record<string, unknown> | null
  ts: string
}

export interface MonolineTheme {
  id: string
  label: string
  mode: string
  accent: string | null
  paper: string | null
  ink: string | null
}

export interface MonolineVoice {
  id: string
  label: string
  lang: string
  group: string
  gender: string
}

export interface MonolineHealth {
  kokoro_status: string
  kokoro_available: boolean
  voices: number
  ffmpeg: boolean
  ffprobe: boolean
  node_bin: string
  node_ok: boolean
  hyperframes_version: string
  chrome_available: boolean
  render_ready: boolean
}

export interface MonolineAsset {
  rel: string
  bytes: number
}

export interface MonolineBrand {
  id?: string
  label: string
  theme: string
  accent: string | null
  logo_name: string | null
}

export const monolineApi = {
  status: () => api.get<{ running: boolean; job_id: string | null }>('/api/monoline/status'),
  health: () => api.get<MonolineHealth>('/api/monoline/health'),
  create: (script: string, config?: Record<string, unknown>, canvas?: Record<string, unknown>) =>
    api.post<{ id: string }>('/api/monoline/jobs', { script, config: config ?? {}, canvas: canvas ?? {} }),
  list: (limit = 50) => api.get<{ jobs: MonolineJob[] }>(`/api/monoline/jobs?limit=${limit}`),
  get: (id: string) => api.get<MonolineJob>(`/api/monoline/jobs/${id}`),
  remove: (id: string) => api.delete<{ ok: boolean }>(`/api/monoline/jobs/${id}`),
  buildOutline: (id: string) => api.post<OutlineView>(`/api/monoline/jobs/${id}/outline`),
  getOutline: (id: string) => api.get<OutlineView>(`/api/monoline/jobs/${id}/outline`),
  applyOutline: (id: string, entries: Array<Record<string, unknown>>) =>
    api.patch<OutlineView>(`/api/monoline/jobs/${id}/outline`, { entries }),
  run: (id: string, force = false) =>
    api.post<{ id: string; status: string }>(`/api/monoline/jobs/${id}/run${force ? '?force=1' : ''}`),
  cancel: (id: string) => api.post<{ cancelled: boolean }>(`/api/monoline/jobs/${id}/cancel`),
  events: (id: string, limit = 500) =>
    api.get<{ events: MonolineEvent[] }>(`/api/monoline/jobs/${id}/events?limit=${limit}`),
  fileUrl: (id: string, rel: string) => `${API_BASE}/api/monoline/jobs/${id}/files/${rel}`,
  themes: () => api.get<{ themes: MonolineTheme[] }>('/api/monoline/themes'),
  voices: () => api.get<{ voices: MonolineVoice[]; default: string }>('/api/monoline/voices'),
  eventsUrl: () => `${API_BASE}/api/monoline/events`,
  jobStreamUrl: (id: string) => `${API_BASE}/api/monoline/jobs/${id}/stream`,
  sampleUrl: (voice: string) => `${API_BASE}/api/monoline/voices/${voice}/sample`,
  uploadAsset: (id: string, file: File) => {
    const form = new FormData()
    form.append('file', file)
    return api.postForm<{ rel: string; bytes: number }>(`/api/monoline/jobs/${id}/assets`, form)
  },
  listAssets: (id: string) => api.get<{ assets: MonolineAsset[] }>(`/api/monoline/jobs/${id}/assets`),
  uploadBgm: (id: string, file: File, volume = 0.22, duck = true) => {
    const form = new FormData()
    form.append('file', file)
    form.append('volume', String(volume))
    form.append('duck', String(duck))
    return api.postForm<{ bgm: Record<string, unknown> }>(`/api/monoline/jobs/${id}/bgm`, form)
  },
  removeBgm: (id: string) => api.delete<{ removed: boolean }>(`/api/monoline/jobs/${id}/bgm`),
  uploadLogo: (id: string, file: File) => {
    const form = new FormData()
    form.append('file', file)
    return api.postForm<{ rel: string; bytes: number }>(`/api/monoline/jobs/${id}/logo`, form)
  },
  removeLogo: (id: string) => api.delete<{ removed: boolean }>(`/api/monoline/jobs/${id}/logo`),
  patchSegment: (id: string, i: number, text: string) =>
    api.patch<{ version: number; beat_duration: number }>(`/api/monoline/jobs/${id}/segments/${i}`, { text }),
  patchScene: (id: string, i: number, body: { kind?: string; slots?: Record<string, unknown> }) =>
    api.patch<{ version: number; ok: boolean }>(`/api/monoline/jobs/${id}/plan/scenes/${i}`, body),
  reorder: (id: string, order: number[]) =>
    api.post<{ version: number; total_duration: number }>(`/api/monoline/jobs/${id}/reorder`, { order }),
  revoice: (id: string, voice: string) =>
    api.post<{ version: number; voice: string }>(`/api/monoline/jobs/${id}/voice`, { voice }),
  patchConfig: (id: string, body: Record<string, unknown>) =>
    api.patch<Record<string, unknown>>(`/api/monoline/jobs/${id}/config`, body),
  suggest: (id: string, i: number) =>
    api.post<{
      status: 'changed' | 'kept' | 'rejected' | 'unanswered'
      kind: string | null
      slots: Record<string, unknown> | null
      model?: string
      seconds?: number
      why: string[]
      error: string
      cached?: boolean
    }>(`/api/monoline/jobs/${id}/plan/scenes/${i}/suggest`),
  generateScript: (topic: string, tone = 'neutral', length = 'medium') =>
    api.post<{ script: string; beats: number; model: string }>('/api/monoline/script', {
      topic,
      tone,
      length,
    }),
  getBrand: () => api.get<MonolineBrand>('/api/monoline/brand'),
  updateBrand: (body: Partial<MonolineBrand>) => api.patch<MonolineBrand>('/api/monoline/brand', body),
  uploadBrandLogo: (file: File) => {
    const form = new FormData()
    form.append('file', file)
    return api.postForm<MonolineBrand>('/api/monoline/brand/logo', form)
  },
  removeBrandLogo: () => api.delete<MonolineBrand>('/api/monoline/brand/logo'),
}
