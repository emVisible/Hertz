/** Layout 域 API：MD Studio 排版稿 CRUD 与导入（/api/layout/*，设计 §6）。
 *
 * 后端零渲染：这里只搬运 markdown 文本与配置 JSON；解析/排版/导出全在前端 @hertz/mdcore。
 * 列表端点不含 source_md 全文，单稿端点是全稿。
 */

import { api } from './client'

export type LayoutPlatform = 'wechat' | 'xhs' | 'zhihu'

/** 列表项（无 source_md） */
export interface LayoutSummary {
  id: string
  title: string
  platform: LayoutPlatform
  theme_id: string
  updated_at: string | null
  /** 软删时间（W2 回收站）；列表里用它区分"活的"与"回收站里的" */
  deleted_at?: string | null
}

/** 版本历史的一行（列表里只给摘要，全文要按 seq 取回） */
export interface LayoutRevisionSummary {
  seq: number
  title: string
  created_at: string | null
  /** 前 120 字预览 */
  preview: string
  chars: number
}

/** 完整单稿 */
export interface LayoutDoc extends LayoutSummary {
  source_md: string
  source_ref: string | null
  overrides: Record<string, unknown>
  cover: Record<string, unknown>
  created_at: string | null
  /** 软删时间（W2 回收站）；非 null = 在回收站里 */
  deleted_at?: string | null
}

export interface LayoutCreateBody {
  title?: string
  source_md?: string
  source_ref?: string | null
  platform: LayoutPlatform
  theme_id?: string
  overrides?: Record<string, unknown>
  cover?: Record<string, unknown>
}

export type LayoutUpdateBody = Partial<Omit<LayoutCreateBody, 'platform'>> & {
  platform?: LayoutPlatform
}

/** 导入产物（docs 空间 / Studio run），附建议标题 */
export interface LayoutImportResult {
  content: string
  suggested_title: string
  path?: string
  run?: string
}

export const layoutApi = {
  list: () => api.get<LayoutSummary[]>('/api/layout'),
  create: (body: LayoutCreateBody) => api.post<LayoutDoc>('/api/layout', body),
  get: (id: string) => api.get<LayoutDoc>(`/api/layout/${id}`),
  update: (id: string, body: LayoutUpdateBody) => api.put<LayoutDoc>(`/api/layout/${id}`, body),
  /** 软删：进回收站，可恢复（W2） */
  remove: (id: string) => api.delete<{ ok: boolean }>(`/api/layout/${id}`),
  /** 回收站列表 */
  listDeleted: () => api.get<LayoutSummary[]>('/api/layout?deleted=true'),
  /** 从回收站捞回来 */
  restore: (id: string) => api.post<LayoutDoc>(`/api/layout/${id}/restore`),
  /** 真删（不可逆，只对回收站里的稿开放） */
  purge: (id: string) => api.post<{ ok: boolean }>(`/api/layout/${id}/purge`),
  /** 版本历史（最近的在前） */
  revisions: (id: string, limit = 20) =>
    api.get<{ revisions: LayoutRevisionSummary[] }>(`/api/layout/${id}/revisions?limit=${limit}`),
  /** 回到某一版；服务端会先给当前内容再存一份，所以这一步本身可逆 */
  restoreRevision: (id: string, seq: number) =>
    api.post<LayoutDoc>(`/api/layout/${id}/revisions/${seq}/restore`),
  importDocs: (path: string) =>
    api.get<LayoutImportResult>(`/api/layout/import/docs?path=${encodeURIComponent(path)}`),
  importStudio: (run: string) =>
    api.get<LayoutImportResult>(`/api/layout/import/studio?run=${encodeURIComponent(run)}`),
}
