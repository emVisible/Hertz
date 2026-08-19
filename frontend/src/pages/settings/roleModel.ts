/** 角色 → 生效模型解析（与后端 ProviderRegistry.resolve_role 回退链保持一致，单一真相）。 */

import type { AIModelDTO, AIProviderDTO } from '../../api/ai'

export interface ModelOption {
  value: string
  label: string
  providerName: string
  modelKey: string
  capability: string
}

export interface ModelPool {
  chat: ModelOption[]
  embedding: ModelOption[]
  tts: ModelOption[]
}

export function buildModelPool(providers: AIProviderDTO[], models: AIModelDTO[]): ModelPool {
  const pool: ModelPool = { chat: [], embedding: [], tts: [] }
  for (const p of providers) {
    if (!p.enabled) continue
    for (const m of models.filter((x) => x.provider_id === p.id && x.enabled)) {
      const opt: ModelOption = {
        value: `${p.key}:${m.key}`,
        label: `${p.name} · ${m.key}`,
        providerName: p.name,
        modelKey: m.key,
        capability: m.capability,
      }
      if (m.capability === 'chat') pool.chat.push(opt)
      if (m.capability === 'embedding') pool.embedding.push(opt)
      if (m.capability === 'tts') pool.tts.push(opt)
    }
  }
  return pool
}

/** 当前生效解析：角色配置 → 回退链 → 首个可用（与后端 resolve_role 一致）。 */
export function effectiveModel(
  roleKey: string,
  roles: Record<string, string>,
  pool: ModelPool,
): ModelOption | null {
  const all = [...pool.chat, ...pool.embedding, ...pool.tts]
  const configured = roles[roleKey]
  if (configured) {
    const hit = all.find((m) => m.value === configured)
    if (hit) return hit
  }
  if (roleKey === 'tts') return pool.tts[0] ?? null
  if (roleKey !== 'main' && roles.main) {
    const hit = pool.chat.find((m) => m.value === roles.main)
    if (hit) return hit
  }
  return pool.chat[0] ?? null
}

/** 是否显式配置（区别于回退生效）。 */
export function roleConfigured(roleKey: string, roles: Record<string, string>): boolean {
  return !!roles[roleKey]
}
