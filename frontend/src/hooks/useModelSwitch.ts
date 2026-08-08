import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { aiRegistryApi } from '../api/ai'
import { useToast } from '../components/ui'

export interface ModelChoice {
  value: string // provider:model
  label: string
}

/**
 * 运行时模型切换（使用层）：在编排/执行页快速切换「指定角色」的模型。
 * 原理：写入 ai_roles.<role>（runtime.yaml），TaskRouter 下次调用即生效——
 * 与应用层（engine）零耦合，符合 AXIOM §2.2。
 * Studio 用 main；流水线评分消费 fast（v0.2.0 参数化）。
 */
export function useModelSwitch(role: 'main' | 'fast' = 'main') {
  const { t } = useTranslation()
  const toast = useToast()
  const queryClient = useQueryClient()

  const { data: providers = [] } = useQuery({
    queryKey: ['ai-providers'],
    queryFn: aiRegistryApi.listProviders,
  })
  const { data: models = [] } = useQuery({
    queryKey: ['ai-models'],
    queryFn: () => aiRegistryApi.listModels(),
  })
  const { data: roles } = useQuery({
    queryKey: ['ai-roles'],
    queryFn: () => aiRegistryApi.getRoles().then((r) => r.roles),
  })

  const chatModels: ModelChoice[] = []
  for (const p of providers) {
    if (!p.enabled) continue
    for (const m of models.filter((x) => x.provider_id === p.id && x.enabled)) {
      if (m.capability !== 'chat') continue
      chatModels.push({ value: `${p.key}:${m.key}`, label: `${p.name} · ${m.key}` })
    }
  }

  const current = roles?.[role] ?? ''

  async function switchModel(value: string) {
    try {
      await aiRegistryApi.saveRoles({ ...(roles ?? {}), [role]: value })
      await queryClient.invalidateQueries({ queryKey: ['ai-roles'] })
      toast(value ? t('settings.roleSwitched') : t('settings.roleReset'), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  return { chatModels, current, switchModel }
}
