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
}

/** 完整单稿 */
export interface LayoutDoc extends LayoutSummary {
  source_md: string
  source_ref: string | null
  overrides: Record<string, unknown>
  cover: Record<string, unknown>
  created_at: string | null
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
  remove: (id: string) => api.delete<{ ok: boolean }>(`/api/layout/${id}`),
  importDocs: (path: string) =>
    api.get<LayoutImportResult>(`/api/layout/import/docs?path=${encodeURIComponent(path)}`),
  importStudio: (run: string) =>
    api.get<LayoutImportResult>(`/api/layout/import/studio?run=${encodeURIComponent(run)}`),
}
