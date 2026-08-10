/** AI 底座 v2.0 API：Provider / 模型 / 角色 / 调用链管理。 */

import { api, API_BASE } from './client'

export interface AIProviderDTO {
  id: string
  key: string
  name: string
  template: string
  protocol: string
  base_url: string
  enabled: boolean
  sort_order: number
  keys_count: number
  keys_set: boolean
  created_at: string | null
  last_fetch_at: string | null
}

export interface AIModelDTO {
  id: string
  provider_id: string
  key: string
  name: string
  capability: string
  context_window: number | null
  enabled: boolean
}

export interface ProviderTemplate {
  key: string
  name: string
  base_url: string
  desc: string
  needs_key: boolean
  protocol: string
  models: [string, string, string][]
}

export interface AITraceCall {
  id: string
  task_id: string | null
  caller: string
  provider_key: string
  model_key: string
  role: string
  operation: string
  duration_ms: number
  status: string
  error: string | null
  result_summary: string | null
  /** v0.5 E 成本估算：usage（无 usage 的 provider 为 null） */
  prompt_tokens?: number | null
  completion_tokens?: number | null
  created_at: string | null
}

export const aiRegistryApi = {
  templates: () => api.get<{ templates: ProviderTemplate[] }>('/api/ai/templates'),
  listProviders: () => api.get<AIProviderDTO[]>('/api/ai/providers'),
  createProvider: (body: { name: string; template: string; base_url?: string; api_keys?: string[] }) =>
    api.post<AIProviderDTO>('/api/ai/providers', body),
  updateProvider: (
    id: string,
    body: { name?: string; base_url?: string; api_keys?: string[]; enabled?: boolean },
  ) => api.put<AIProviderDTO>(`/api/ai/providers/${id}`, body),
  removeProvider: (id: string) => api.delete<{ ok: boolean }>(`/api/ai/providers/${id}`),
  fetchModels: (id: string) => api.post<AIModelDTO[]>(`/api/ai/providers/${id}/fetch-models`),
  testProvider: (id: string, model_key?: string) =>
    api.post<{ ok: boolean; model?: string; reply?: string; detail?: string }>(
      `/api/ai/providers/${id}/test`,
      { model_key },
    ),
  listModels: (providerId?: string) =>
    api.get<AIModelDTO[]>(`/api/ai/models${providerId ? `?provider_id=${providerId}` : ''}`),
  addModel: (body: { provider_id: string; key: string; name?: string; capability?: string }) =>
    api.post<AIModelDTO>('/api/ai/models', body),
  updateModel: (id: string, body: { name?: string; enabled?: boolean; capability?: string }) =>
    api.put<AIModelDTO>(`/api/ai/models/${id}`, body),
  removeModel: (id: string) => api.delete<{ ok: boolean }>(`/api/ai/models/${id}`),
  getRoles: () => api.get<{ roles: Record<string, string> }>('/api/ai/roles'),
  saveRoles: (roles: Record<string, string>) => api.put<{ roles: Record<string, string> }>('/api/ai/roles', { roles }),
  trace: (taskId?: string, limit = 50) =>
    api.get<AITraceCall[]>(`/api/ai/trace?limit=${limit}${taskId ? `&task_id=${taskId}` : ''}`),
  /** TTS 试听（v0.4 B2）：短句合成返回 mpeg 音频二进制 */
  ttsTest: async (text: string, voice: string) => {
    const resp = await fetch(`${API_BASE}/api/ai/tts/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice }),
    })
    if (!resp.ok) {
      let detail = resp.statusText
      try {
        const body = (await resp.json()) as { detail?: string }
        detail = body.detail ?? detail
      } catch {
        /* keep statusText */
      }
      throw new Error(detail)
    }
    return new Uint8Array(await resp.arrayBuffer())
  },
}
