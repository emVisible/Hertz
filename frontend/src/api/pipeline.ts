/** Execution-domain (content pipeline) API types + calls. */

import { api, API_BASE } from './client'
import {
  DEFAULT_PRE_FILTERS,
  facetsQuery,
  itemsQuery,
  type PreReviewFilters,
} from '../core/preReviewFilter'

/** 空壳池一次取多少条（异常区标题靠它判断数字是不是被截断） */
export const INVALID_POOL_LIMIT = 200

/** 分面计数（v0.34 A）：total 是不加轴的全量分母，hit 是加满当前轴之后的数——
 *  两个数分开给，界面才分得清「筛没了」和「本来就没有」。
 *  `unfilled` 是「分数没采到」那一档的计数（缺值单列，不混进低质量）。
 *  注意三档 + unfilled **不等于** total（还有一格只有 ratio 没 score），界面
 *  不许把它们说成互补划分。 */
export interface ItemFacets {
  total: number
  hit: number
  by_quality: { loose: number; standard: number; strict: number }
  with_text: number
  without_text: number
  unfilled: number
}


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
  /** 内容分层（v0.13 策略）：仅发布队列视图（queueView）序列化携带 */
  tier?: ContentTier
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
  /** 发布队列相位（v0.12）：''=手动｜holding=预发布队列｜ready=发布队列 */
  queue_phase?: '' | 'holding' | 'ready'
  /** 归属栏目（v0.22 栏目化，后端 _serialize 全量携带，日历欄目色用） */
  channel_key?: string | null
  /** 制作优先级（v0.26 运营面板，默认 0；engine 取件降序） */
  priority?: number
  /** 软归档（wave10）：备用库标记——异常区删除入口 */
  archived?: boolean
  /** 空壳隔离（v0.33）：无媒体且无正文 → 不在流水线计数里，只出现在异常区 */
  is_invalid?: boolean
}

/** 发布队列相位（v0.12）：与后端 publish_queue 常量一致 */
export type QueuePhase = '' | 'holding' | 'ready'

/** 发布队列看板（v0.12；v0.13 增账号画像） */
export interface PublishQueueView {
  ready: PipelineItem[]
  holding: PipelineItem[]
  today: {
    auto_published: number
    daily_limit: number
    auto_enabled: boolean
  }
  /** 发布策略引擎（v0.13）：strategy_enabled=false 时为 null——前端隐藏状态卡 */
  account: {
    phase: 'warmup' | 'normal' | 'caution' | 'cooldown'
    quota: number
    used: number
    reasons: string[]
    days: Array<{ date: string; uploads: number; views_median: number | null }>
  } | null
  /** 影子计划（v0.18）：dry_run 下策略「将会做什么」 */
  shadow_plan: Array<{ title: string; subreddit: string; scheduled_at: string }>
}

/** 内容分层（v0.13 策略）：队列条目由后端标注 */
export type ContentTier = 'premier' | 'regular' | 'filler'

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
  /** 列表轻量摘要（v0.8.8）：collect 逐源 ok/err 计数——展开时经 /jobs/{id} 取全量 */
  sources_ok?: number
  sources_err?: number
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
  /** 任务耗时秒（v0.8.7）：finished-started */
  duration_s: number | null
}

/** 采集轮次逐源明细（v0.8.7）：活动面板/采集卡展开用。 */
export interface CollectSourceRun {
  channel: string
  collected?: number
  inserted?: number
  skipped?: number
  cooldown_s?: number
  error?: string
  empty?: boolean
}

export interface JobListResult {
  total: number
  jobs: PipelineJob[]
}

export interface LogLineHistory {
  ts: string
  level: 'INFO' | 'WARNING' | 'ERROR'
  logger: string
  message: string
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
  /** 采集进度明细（v0.8.2）：job_step collect 各源状态 */
  sources?: Array<{ channel: string; collected?: number; inserted?: number; cooldown_s?: number; error?: string }>
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
  /** 条目列表。v0.34 A：三轴筛选走 query（服务端筛——limit 500 < 活口 2659，
   *  客户端筛只能看到最新 500 条，会得出「没有情感内容」的假结论）。 */
  items: (status?: string, limit = 50, filters: PreReviewFilters = DEFAULT_PRE_FILTERS) =>
    api.get<PipelineItem[]>(`/api/pipeline/items?${itemsQuery(status, limit, filters)}`),
  /** 分面计数（v0.34 A）：与列表同一批轴参数，缺省不带 limit。 */
  itemFacets: (status?: string, filters: PreReviewFilters = DEFAULT_PRE_FILTERS) =>
    api.get<ItemFacets>(`/api/pipeline/items/facets?${facetsQuery(status, filters)}`),
  counts: () => api.get<Record<string, number>>('/api/pipeline/items/counts'),
  /** 采集运维状态（v0.8.2）：运行中/上次结果/下次自动/间隔 */
  collectStatus: () =>
    api.get<{
      running: boolean
      job: string | null
      interval_min: number
      auto_enabled: boolean
      next_in_s: number | null
      last: {
        status: string | null
        started_at: string | null
        summary: Record<string, unknown>
        error: string | null
      }
    }>('/api/pipeline/collect/status'),
  /** 看板趋势（v0.5 B）：采集/入库/发布按天聚合 */
  trends: (days = 30) =>
    api.get<Array<{ date: string; collected: number; inserted: number; published: number }>>(
      `/api/pipeline/trends?days=${days}`,
    ),
  calendar: (from: string, to: string) =>
    api.get<{ items: PipelineItem[]; unscheduled: PipelineItem[] }>(
      `/api/pipeline/calendar?from=${from}&to=${to}`,
    ),
  approve: (id: string) => api.post<{ id: string; status: string }>(`/api/pipeline/items/${id}/approve`),
  reject: (id: string, reason = '') =>
    api.post<{ id: string; status: string }>(`/api/pipeline/items/${id}/reject?reason=${encodeURIComponent(reason)}`),
  retry: (id: string) => api.post<{ id: string; status: string }>(`/api/pipeline/items/${id}/retry`),
  /** 重新翻译（v0.8.9）：ASR 原声→中文字幕，原声保留无 TTS */
  retranslate: (id: string) =>
    api.post<{ id: string; status: string }>(`/api/pipeline/items/${id}/retranslate`),
  /** 打回审核（v0.3.9 相邻双向）：rejected/approved/published → queued */
  requeue: (id: string) => api.post<{ id: string; status: string }>(`/api/pipeline/items/${id}/requeue`),

  /** 审核打回预处理（v0.3.9）：queued → scored */
  backToPrep: (id: string) =>
    api.post<{ id: string; status: string }>(`/api/pipeline/items/${id}/back-to-prep`),

  /** 批量审核操作（v0.4 A2）：逐条执行，失败不中断 */
  batch: (action: string, ids: string[]) =>
    api.post<{ ok: number; failed: Array<{ id: string; error: string }> }>(
      '/api/pipeline/items/batch',
      { action, ids },
    ),
  /** 备用库（wave10）：archived 条目列表 */
  archivedItems: (limit = 200) =>
    api.get<PipelineItem[]>(`/api/pipeline/items/archived?limit=${limit}`),
  /** 空壳池（v0.33）：is_invalid 条目 + 隔离原因（error 文本）。
   *  上限只在一处定义：池子标题要靠它判断数字是不是被截断的。 */
  invalidItems: (limit = INVALID_POOL_LIMIT) =>
    api.get<PipelineItem[]>(`/api/pipeline/items/invalid?limit=${limit}`),
  /** 批量归档（wave10）：磁盘清理 + 字段清洗 + 标记 archived */
  archive: (ids: string[]) =>
    api.post<{ ok: number; failed: Array<{ id: string; error: string }> }>(
      '/api/pipeline/items/archive',
      { ids },
    ),
  /** 批量恢复（wave10）：清除 archived 标记 */
  unarchive: (ids: string[]) =>
    api.post<{ ok: number; failed: Array<{ id: string; error: string }> }>(
      '/api/pipeline/items/unarchive',
      { ids },
    ),
  /** 批量彻底删除（wave10，不可逆）：仅归档条目 */
  purge: (ids: string[]) =>
    api.post<{ ok: number; failed: Array<{ id: string; error: string }> }>(
      '/api/pipeline/items/purge',
      { ids },
    ),
  /** 单条制作（v0.3.4，预处理「制作」按钮）。 */
  produce: (id: string) => api.post<{ id: string; status: string; outcome: string }>(`/api/pipeline/items/${id}/produce`),
  // 取消制作（wave11）：协作式——产线检查点命中后条目回滚 downloaded
  cancelProduce: (id: string) =>
    api.post<{ ok: boolean; cancelling: boolean }>(`/api/pipeline/items/${id}/produce-cancel`),
  /** 单条评分（v0.3.5，预处理手动评分按钮）。 */
  score: (id: string) => api.post<{ id: string; status: string; outcome: string }>(`/api/pipeline/items/${id}/score`),
  /** 单条下载（v0.8.6 评分先行，预处理手动下载按钮）。 */
  download: (id: string, skipScore = false) =>
    api.post<{ id: string; status: string; outcome: string }>(`/api/pipeline/items/${id}/download${skipScore ? '?skip_score=1' : ''}`),
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
  /** 制作优先级落库（v0.26 运营面板）：按给定顺序赋 priority，首位最高。 */
  setPriority: (orderedIds: string[]) =>
    api.post<{ updated: number }>('/api/pipeline/items/priority', { ordered_ids: orderedIds }),
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
  publish: (id: string, selfmade = false, target = '', now = false) =>
    api.post<{ id: string; status: string; noop?: boolean }>(
      `/api/pipeline/items/${id}/publish?selfmade=${selfmade ? 1 : 0}&target=${encodeURIComponent(target)}&now=${now ? 1 : 0}`,
    ),
  /** 随机抽帧封面（v0.11.5）：视频内随机一帧 → 覆盖 cover_path。 */
  randomCover: (id: string) =>
    api.post<{ id: string; cover_path: string }>(`/api/pipeline/items/${id}/cover-random`),
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
  run: (step: string, limit = 10, channel = '', unscored = false) =>
    api.post<PipelineJob>(
      `/api/pipeline/run?step=${step}&limit=${limit}${channel ? `&channel=${encodeURIComponent(channel)}` : ''}${unscored ? '&unscored=1' : ''}`,
    ),
  chain: (limit = 10) => api.post<Record<string, PipelineJob>>(`/api/pipeline/chain?limit=${limit}`),
  cancel: () => api.post<{ ok: boolean; cancelling: boolean }>('/api/pipeline/cancel'),
  /** 任务历史分页（v0.8.7）：类型/状态筛选 + offset 分页。 */
  jobsPage: (limit = 50, offset = 0, jobName = '', status = '') =>
    api.get<JobListResult>(
      `/api/pipeline/jobs?limit=${limit}&offset=${offset}${jobName ? `&job_name=${encodeURIComponent(jobName)}` : ''}${status ? `&status=${encodeURIComponent(status)}` : ''}`,
    ),
  /** 单任务详情（v0.8.7）：活动面板展开。 */
  jobDetail: (id: string) => api.get<PipelineJob>(`/api/pipeline/jobs/${id}`),
  /** 采集历史轮次（v0.8.7）：最近 N 轮逐源明细。 */
  collectHistory: (limit = 10) =>
    api.get<PipelineJob[]>(`/api/pipeline/collect/history?limit=${limit}`),
  sources: () => api.get<SourceState[]>('/api/pipeline/sources'),
  supply: () => api.get<{ warnings: string[] }>('/api/pipeline/supply'),
  failures: () => api.get<Record<string, number>>('/api/pipeline/failures'),
  retryClass: (cls: string) => api.post<{ cls: string; requeued: number }>('/api/pipeline/retry-class', { cls }),
  nextScheduleSlot: () => api.get<{ recommended_at: string }>('/api/pipeline/schedule/next'),
  /** 发布队列看板（v0.12）：ready/holding 列表 + 今日产能 */
  queueView: () => api.get<PublishQueueView>('/api/pipeline/publish/queue'),
  /** 入队/出队（v0.12）：phase ''=出队｜holding｜ready */
  enqueue: (id: string, phase: QueuePhase) =>
    api.post<{ id: string; queue_phase: QueuePhase; scheduled_at: string | null }>(
      `/api/pipeline/items/${id}/queue`,
      { phase },
    ),
  /** 批量入队（v0.12）：逐条执行，失败不中断 */
  enqueueBatch: (ids: string[], phase: QueuePhase) =>
    api.post<{ ok: number; failed: Array<{ id: string; error: string }> }>(
      '/api/pipeline/items/batch/queue',
      { ids, phase },
    ),
  eventsUrl: () => `${API_BASE}/api/pipeline/events`,
}
