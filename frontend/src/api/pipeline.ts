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

export type ProduceModule = 'passthrough' | 'voice' | 'subtitle' | 'translate' | 'mute'

export type ProduceOptions = Record<ProduceModule, boolean>

export interface PipelineItem {
  id: string
  /** 入库自增序号（v0.3.1）：真实入库顺序——同批 created_at 相同 */
  seq: number | null
  status: ItemStatus
  /** 生产方式模块集合（v0.3.3，预处理人工选择） */
  produce_options: ProduceOptions | null
  item_type: string
  source: string
  source_url: string
  media_url: string | null
  source_id: string
  title: string
  subreddit: string
  author: string
  reddit_score: number
  upvote_ratio: number
  score_total: number | null
  score_dimensions: Record<string, number> | null
  score_reasons: string[]
  is_lowscore: boolean
  raw_path: string | null
  video_path: string | null
  cover_path: string | null
  script_json: Record<string, unknown> | null
  publish_json: Record<string, unknown> | null
  error: string | null
  error_class: string
  /** 审核相似提示（v0.5 A）：phash 汉明 ≤5 的相似内容标题（排除同源同帖） */
  similar?: { published: string[]; queued: string[] }
  retry_count: number
  /** 分区自动建议（v0.2.7）：未手动设置 tid 时的推荐分区 */
  auto_tid: number | null
  created_at: string | null
  /** 最近操作（v0.3.12）：状态迁移自动刷新——「最新在前」排序要素 */
  updated_at: string | null
  approved_at: string | null
  scheduled_at: string | null
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
  /** 采集 0 条（v0.2.8）：源返回空列表，已记健康度并冷却 */
  empty?: boolean
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
  consecutive_fails: number
  last_error: string | null
  last_error_at: string | null
  last_run_at: string | null
  health: 'healthy' | 'degraded' | 'dead'
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
  /** collect 明细（v0.3.0，job_step 事件平铺 summary 字段） */
  collected?: number
  inserted?: number
  skipped?: number
  empty?: boolean
  cooldown_s?: number
  /** 单步结果明细（ok/rejected/failed） */
  ok?: number
  rejected?: number
  failed?: number
}

export const pipelineApi = {
  status: () => api.get<{ running: boolean; job: string | null }>('/api/pipeline/status'),

  /** 发布健康状态（v0.3.8）：生效目标 + B 站 cookie 就绪度 + biliup 可用性 */
  publishStatus: () =>
    api.get<{
      target: string
      biliup_available: boolean
      cookie_exists: boolean
      cookie_path: string
      cookie_age_s: number | null
      publishers: string[]
      noop: boolean
    }>('/api/pipeline/publish/status'),
  steps: () => api.get<{ steps: string[] }>('/api/pipeline/steps'),
  items: (status?: string, limit = 50) =>
    api.get<PipelineItem[]>(
      `/api/pipeline/items?limit=${limit}${status ? `&status=${status}` : ''}`,
    ),
  counts: () => api.get<Record<string, number>>('/api/pipeline/items/counts'),
  calendar: (from: string, to: string) =>
    api.get<{ items: PipelineItem[]; unscheduled: PipelineItem[] }>(
      `/api/pipeline/calendar?from=${from}&to=${to}`,
    ),
  approve: (id: string) => api.post<{ id: string; status: string }>(`/api/pipeline/items/${id}/approve`),
  reject: (id: string, reason = '') =>
    api.post<{ id: string; status: string }>(`/api/pipeline/items/${id}/reject?reason=${encodeURIComponent(reason)}`),
  retry: (id: string) => api.post<{ id: string; status: string }>(`/api/pipeline/items/${id}/retry`),
  /** 打回审核（v0.3.9 相邻双向）：rejected/approved/published → queued */
  requeue: (id: string) => api.post<{ id: string; status: string }>(`/api/pipeline/items/${id}/requeue`),

  /** 审核打回预处理（v0.3.9）：queued → scored */
  backToPrep: (id: string) =>
    api.post<{ id: string; status: string }>(`/api/pipeline/items/${id}/back-to-prep`),

  /** 预处理打回采集（v0.3.9）：downloaded/scored → discovered */
  backToCollect: (id: string) =>
    api.post<{ id: string; status: string }>(`/api/pipeline/items/${id}/back-to-collect`),

  /** 批量审核操作（v0.4 A2）：逐条执行，失败不中断 */
  batch: (action: string, ids: string[]) =>
    api.post<{ ok: number; failed: Array<{ id: string; error: string }> }>(
      '/api/pipeline/items/batch',
      { action, ids },
    ),
  /** 单条制作（v0.3.4，预处理「制作」按钮）。 */
  produce: (id: string) => api.post<{ id: string; status: string; outcome: string }>(`/api/pipeline/items/${id}/produce`),
  /** 单条评分（v0.3.5，预处理手动评分按钮）。 */
  score: (id: string) => api.post<{ id: string; status: string; outcome: string }>(`/api/pipeline/items/${id}/score`),
  /** 过期排期自动重排（v0.2.7）：进入审核时调用。 */
  rescheduleExpired: () => api.post<{ updated: number }>('/api/pipeline/reschedule-expired'),
  /** 发布数据补录（v0.4 C1）：自动回捞失败时手动填播放/互动 */
  setPublishStats: (id: string, stats: Record<string, number>) =>
    api.post<{ id: string; ok: boolean; stats: Record<string, number> }>(
      `/api/pipeline/items/${id}/publish-stats`,
      stats,
    ),
  /** 生产方式批量设置（v0.3.3，预处理人工选择）。 */
  setProduceOptions: (ids: string[], options: Partial<ProduceOptions>) =>
    api.post<{ updated: number }>('/api/pipeline/produce-options', { ids, options }),
  /** 生产方式预设模板（v0.4 B3）：命名组合一键套用。 */
  produceTemplates: () =>
    api.get<Array<{ id: string; name: string; options: ProduceOptions; builtin: boolean }>>(
      '/api/pipeline/produce-templates',
    ),
  createProduceTemplate: (name: string, options: Partial<ProduceOptions>) =>
    api.post<{ id: string; name: string; options: ProduceOptions }>('/api/pipeline/produce-templates', {
      name,
      options,
    }),
  removeProduceTemplate: (id: string) =>
    api.delete<{ ok: boolean }>(`/api/pipeline/produce-templates/${id}`),
  updateMeta: (id: string, meta: Record<string, string | number | null>) =>
    api.put<{ id: string; ok: boolean }>(`/api/pipeline/items/${id}/meta`, meta),
  publish: (id: string, selfmade = false, target = '') =>
    api.post<{ id: string; status: string; noop?: boolean }>(
      `/api/pipeline/items/${id}/publish?selfmade=${selfmade ? 1 : 0}&target=${encodeURIComponent(target)}`,
    ),
  /** 上传替换封面（v0.2.6）：FormData multipart。 */
  uploadCover: async (id: string, file: File): Promise<{ id: string; cover_path: string }> => {
    const form = new FormData()
    form.append('file', file)
    const resp = await fetch(`${API_BASE}/api/pipeline/items/${id}/cover`, {
      method: 'POST',
      body: form,
    })
    if (!resp.ok) {
      const detail = await resp.text()
      throw new Error(detail || `cover upload failed (${resp.status})`)
    }
    return resp.json() as Promise<{ id: string; cover_path: string }>
  },
  run: (step: string, limit = 10) =>
    api.post<PipelineJob>(`/api/pipeline/run?step=${step}&limit=${limit}`),
  chain: (limit = 10) => api.post<Record<string, PipelineJob>>(`/api/pipeline/chain?limit=${limit}`),
  cancel: () => api.post<{ ok: boolean; cancelling: boolean }>('/api/pipeline/cancel'),
  jobs: (limit = 10) => api.get<PipelineJob[]>(`/api/pipeline/jobs?limit=${limit}`),
  sources: () => api.get<SourceState[]>('/api/pipeline/sources'),
  supply: () => api.get<{ warnings: string[] }>('/api/pipeline/supply'),
  failures: () => api.get<Record<string, number>>('/api/pipeline/failures'),
  retryClass: (cls: string) => api.post<{ cls: string; requeued: number }>('/api/pipeline/retry-class', { cls }),
  nextScheduleSlot: () => api.get<{ recommended_at: string }>('/api/pipeline/schedule/next'),
  eventsUrl: () => `${API_BASE}/api/pipeline/events`,
}
