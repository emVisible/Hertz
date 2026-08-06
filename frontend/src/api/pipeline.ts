/** Execution-domain (content pipeline) API types + calls. */

import { api, API_BASE } from './client'

export type ItemStatus =
  | 'discovered'
  | 'scored'
  | 'downloaded'
  | 'queued'
  | 'approved'
  | 'published'
  | 'rejected'
  | 'failed'

export interface PipelineItem {
  id: string
  status: ItemStatus
  item_type: string
  source: string
  source_url: string
  source_id: string
  title: string
  subreddit: string
  author: string
  reddit_score: number
  upvote_ratio: number
  score_total: number | null
  score_reasons: string[]
  raw_path: string | null
  video_path: string | null
  cover_path: string | null
  script_json: Record<string, unknown> | null
  publish_json: Record<string, unknown> | null
  error: string | null
  retry_count: number
  created_at: string | null
  approved_at: string | null
  published_at: string | null
}

export interface JobSummary {
  processed?: number
  ok?: number
  rejected?: number
  failed?: number
  channel?: string
  collected?: number
  inserted?: number
  skipped?: number
  error?: string
  [key: string]: unknown
}

export interface PipelineJob {
  id: string
  job: string
  status: string
  summary: JobSummary
  error: string | null
  started_at: string | null
  finished_at: string | null
}

export interface SourceState {
  source: string
  channel: string
  cursor: Record<string, unknown> | null
  ok_count: number
  fail_count: number
  last_run_at: string | null
}

export type PipelineEventType = 'job_step' | 'item' | 'job_done' | 'log'

export interface PipelineEvent {
  type: PipelineEventType
  job?: string
  job_id?: string
  step?: string
  status?: string
  item_id?: string
  error?: string | null
  summary?: JobSummary
  count?: number
  channel?: string
  message?: string
}

export const pipelineApi = {
  status: () => api.get<{ running: boolean; job: string | null }>('/api/pipeline/status'),
  steps: () => api.get<{ steps: string[] }>('/api/pipeline/steps'),
  items: (status?: string, limit = 50) =>
    api.get<PipelineItem[]>(
      `/api/pipeline/items?limit=${limit}${status ? `&status=${status}` : ''}`,
    ),
  counts: () => api.get<Record<string, number>>('/api/pipeline/items/counts'),
  approve: (id: string) => api.post<{ id: string; status: string }>(`/api/pipeline/items/${id}/approve`),
  reject: (id: string, reason = '') =>
    api.post<{ id: string; status: string }>(`/api/pipeline/items/${id}/reject?reason=${encodeURIComponent(reason)}`),
  retry: (id: string) => api.post<{ id: string; status: string }>(`/api/pipeline/items/${id}/retry`),
  run: (step: string, limit = 10) =>
    api.post<PipelineJob>(`/api/pipeline/run?step=${step}&limit=${limit}`),
  chain: (limit = 10) => api.post<Record<string, PipelineJob>>(`/api/pipeline/chain?limit=${limit}`),
  cancel: () => api.post<{ ok: boolean; cancelling: boolean }>('/api/pipeline/cancel'),
  jobs: (limit = 10) => api.get<PipelineJob[]>(`/api/pipeline/jobs?limit=${limit}`),
  sources: () => api.get<SourceState[]>('/api/pipeline/sources'),
  eventsUrl: () => `${API_BASE}/api/pipeline/events`,
}
