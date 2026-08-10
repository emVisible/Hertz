/** Orchestration API types + calls: roles, teams, briefs, plans, studio runs. */

import { api, API_BASE } from './client'

/** 角色（角色库实体，v4.1）：纯 MD 内容实体——角色名/扮演名 + MD 说明。 */
export interface Role {
  id: string
  key: string
  name: string
  role_name: string
  description: string
  enabled: boolean
  sort_order: number
  created_at: string | null
  updated_at: string | null
}

/** 团队（表名 crews，语义=团队 v4.0）：角色的集合。 */
export interface Crew {
  id: string
  name: string
  description: string
  role_keys: string[]
  roles: Role[]
  created_at: string | null
  updated_at: string | null
}

export interface Brief {
  id: string
  name: string
  content: string
  config: Record<string, unknown>
  created_at: string | null
  updated_at: string | null
}

/** Buff/Debuff（v5.2）：态度/话术注入指令（buff 正向 / debuff 反向禁忌）。 */
export interface Buff {
  id: string
  key: string
  name: string
  kind: 'lightweight' | 'heavy'
  polarity: 'buff' | 'debuff'
  effect: string
  category: 'stable' | 'random'
  enabled: boolean
  builtin: boolean
  sort_order: number
  created_at: string | null
  updated_at: string | null
}

/** 输出深度档位（v0.3.10 可维护化）：并列于 buff/debuff 的库条目 */
export interface DepthLevel {
  id: string
  key: string
  name: string
  effect: string
  enabled: boolean
  builtin: boolean
  sort_order: number
}

export interface PhaseDef {
  key: string
  name: string
  description: string
  type: 'system' | 'agent'
  builtin?: boolean
  phase_type?: string
  output_file?: string
  phase_group?: string
  timeout?: number
  role?: string
  method?: string
  style?: string[]
  model?: string
  retries?: number
}

export interface PhaseOrderItem {
  key: string
  enabled: boolean
  config: Record<string, unknown>
}

export interface Plan {
  id: string
  name: string
  description: string
  mode: 'text' | 'visual' | 'video'
  phase_order: PhaseOrderItem[]
  crew_id: string | null
  brief_id: string | null
  buff_keys: string[]
  created_at: string | null
  updated_at: string | null
}

export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled'

export interface PhaseRunInfo {
  key: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  duration_ms: number | null
  error: string | null
  output: Record<string, string>
  files?: string[]
}

export interface WorkflowRun {
  id: string
  plan_id: string | null
  status: RunStatus
  error: string | null
  context: Record<string, unknown>
  started_at: string | null
  finished_at: string | null
  output_dir: string
  output_path?: string
  phases?: PhaseRunInfo[]
}

export interface StudioEvent {
  type: 'phase_start' | 'log' | 'phase_done' | 'run_done'
  run_id?: string
  phase?: string
  name?: string
  index?: number
  total?: number
  message?: string
  status?: string
  duration_ms?: number
  error?: string | null
  output_dir?: string
}

export const crewsApi = {
  list: () => api.get<Crew[]>('/api/crews'),
  create: (body: { name: string; description?: string; role_keys?: string[] }) =>
    api.post<Crew>('/api/crews', body),
  update: (id: string, body: Partial<Pick<Crew, 'name' | 'description' | 'role_keys'>>) =>
    api.put<Crew>(`/api/crews/${id}`, body),
  remove: (id: string) => api.delete<{ ok: boolean }>(`/api/crews/${id}`),
}

export const rolesApi = {
  list: () => api.get<Role[]>('/api/roles'),
  create: (body: { key: string; name: string; role_name?: string; description?: string }) =>
    api.post<Role>('/api/roles', body),
  update: (id: string, body: Partial<Pick<Role, 'name' | 'role_name' | 'description' | 'enabled'>>) =>
    api.put<Role>(`/api/roles/${id}`, body),
  remove: (id: string) => api.delete<{ ok: boolean }>(`/api/roles/${id}`),
}

export const buffsApi = {
  list: () => api.get<Buff[]>('/api/buffs'),
  create: (body: { key: string; name: string; kind?: string; polarity?: string; effect?: string; category?: string }) =>
    api.post<Buff>('/api/buffs', body),
  update: (id: string, body: Partial<Pick<Buff, 'name' | 'kind' | 'polarity' | 'effect' | 'category' | 'enabled'>>) =>
    api.put<Buff>(`/api/buffs/${id}`, body),
  remove: (id: string) => api.delete<{ ok: boolean }>(`/api/buffs/${id}`),
}

/** 深度档位库（v0.3.10）：输出深度五档可维护化 */
export const depthsApi = {
  list: () => api.get<DepthLevel[]>('/api/depths'),
  create: (body: { key: string; name: string; effect?: string }) =>
    api.post<DepthLevel>('/api/depths', body),
  update: (id: string, body: Partial<Pick<DepthLevel, 'name' | 'effect' | 'enabled'>>) =>
    api.put<DepthLevel>(`/api/depths/${id}`, body),
  remove: (id: string) => api.delete<{ ok: boolean }>(`/api/depths/${id}`),
  restoreDefaults: () => api.post<{ ok: boolean; count: number }>('/api/depths/restore-defaults'),
}

export const briefsApi = {
  list: () => api.get<Brief[]>('/api/briefs'),
  create: (body: { name: string; content?: string }) =>
    api.post<Brief>('/api/briefs', body),
  update: (id: string, body: Partial<Pick<Brief, 'name' | 'content'>>) =>
    api.put<Brief>(`/api/briefs/${id}`, body),
  remove: (id: string) => api.delete<{ ok: boolean }>(`/api/briefs/${id}`),
}

export const plansApi = {
  phases: () => api.get<PhaseDef[]>('/api/phases'),
  createPhase: (body: { name: string; description?: string; method?: string; style?: string[] }) =>
    api.post<PhaseDef>('/api/phases', body),
  updatePhase: (
    key: string,
    body: {
      name?: string
      description?: string
      role?: string
      method?: string
      style?: string[]
      model?: string
      retries?: number
      timeout?: number
    },
  ) => api.put<PhaseDef>(`/api/phases/${key}`, body),
  removePhase: (key: string) => api.delete<{ ok: boolean }>(`/api/phases/${key}`),
  restorePhaseDefaults: () => api.post<{ restored: number }>('/api/phases/restore-defaults'),
  list: () => api.get<Plan[]>('/api/plans'),
  create: (body: Partial<Plan>) => api.post<Plan>('/api/plans', body),
  update: (id: string, body: Partial<Plan>) => api.put<Plan>(`/api/plans/${id}`, body),
  remove: (id: string) => api.delete<{ ok: boolean }>(`/api/plans/${id}`),
  /** 克隆 / 导出 / 导入（v0.4 D2）：模板分享与备份 */
  clone: (id: string, name?: string) =>
    api.post<Plan>(`/api/plans/${id}/clone`, { name }),
  exportPlan: (id: string) =>
    api.get<{ version: number; plan: Plan }>(`/api/plans/${id}/export`),
  importPlan: (payload: unknown) =>
    api.post<Plan>('/api/plans/import', { payload }),
  run: (id: string, input: string, buffKeys?: string[], depth = 'normal') =>
    api.post<{ id: string }>(`/api/plans/${id}/run`, {
      input,
      buff_keys: buffKeys,
      depth,
    }),
}

export const studioApi = {
  runs: (limit = 20) => api.get<WorkflowRun[]>(`/api/studio/runs?limit=${limit}`),
  get: (id: string) => api.get<WorkflowRun>(`/api/studio/runs/${id}`),
  cancel: (id: string) => api.post<{ ok: boolean }>(`/api/studio/runs/${id}/cancel`),
  files: (id: string) => api.get<{ files: string[] }>(`/api/studio/runs/${id}/files`),
  readFile: (id: string, name: string) =>
    api.getText<string>(`/api/studio/runs/${id}/files/${name}`),
  eventsUrl: () => `${API_BASE}/api/studio/events`,
}
