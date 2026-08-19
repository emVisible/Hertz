import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { aiRegistryApi } from '../../api/ai'
import { Badge, Icon, type IconName } from '../../components/ui'
import { buildModelPool, effectiveModel, roleConfigured } from './roleModel'

interface FeatureRow {
  key: string
  icon: IconName
  role: string
  labelKey: string
}

/** 功能 → 角色 对照（来自后端真实调用点；素材整理/评分/翻译同走 fast 池）。 */
const FEATURES: FeatureRow[] = [
  { key: 'organize', icon: 'wand', role: 'fast', labelKey: 'settings.featureOrganize' },
  { key: 'translate', icon: 'briefs', role: 'fast', labelKey: 'settings.featureTranslate' },
  { key: 'score', icon: 'pen', role: 'fast', labelKey: 'settings.featureScore' },
  { key: 'chat', icon: 'studio', role: 'main', labelKey: 'settings.featureChat' },
  { key: 'image', icon: 'box', role: 'image', labelKey: 'settings.featureImage' },
  { key: 'tts', icon: 'whisper', role: 'tts', labelKey: 'settings.featureTts' },
]

const ROLE_LABEL: Record<string, string> = {
  fast: 'settings.roleFast',
  main: 'settings.roleMain',
  image: 'settings.roleImage',
  tts: 'settings.roleTts',
}

/**
 * 功能 → 模型 对照卡（AI 区总览）：每个功能实际由哪个角色、哪颗模型驱动，
 * 配置点在下方「默认模型」。数据与 RolesManager 同源（ai-roles / providers / models）。
 */
export function FeaturesMap() {
  const { t } = useTranslation()
  const { data: providers = [] } = useQuery({
    queryKey: ['ai-providers'],
    queryFn: aiRegistryApi.listProviders,
  })
  const { data: models = [] } = useQuery({
    queryKey: ['ai-models'],
    queryFn: () => aiRegistryApi.listModels(),
  })
  const { data: saved } = useQuery({
    queryKey: ['ai-roles'],
    queryFn: () => aiRegistryApi.getRoles().then((r) => r.roles),
  })

  const pool = buildModelPool(providers, models)
  const roles = saved ?? {}

  return (
    <div className="flex flex-col gap-1.5">
      {FEATURES.map((f) => {
        const eff = effectiveModel(f.role, roles, pool)
        const configured = roleConfigured(f.role, roles)
        return (
          <div key={f.key} className="flex items-center gap-2 border border-border/60 bg-surface-2/40 px-2.5 py-1.5">
            <Icon name={f.icon} size={14} className="shrink-0 text-text-secondary" />
            <span className="min-w-0 flex-1 truncate text-xs text-text-primary">{t(f.labelKey)}</span>
            <Badge tone="neutral">{t(ROLE_LABEL[f.role])}</Badge>
            {eff ? (
              <span
                className="max-w-72 truncate font-mono text-[10px] text-text-secondary"
                title={configured ? eff.label : `${eff.label} · ${t('settings.roleViaFallback')}`}
              >
                {configured ? eff.label : `${eff.label} · ${t('settings.roleViaFallback')}`}
              </span>
            ) : (
              <Badge tone="warning">{t('settings.featureUnconfigured')}</Badge>
            )}
          </div>
        )
      })}
      <p className="mt-1 text-[10px] leading-relaxed text-text-disabled">{t('settings.featuresHint')}</p>
    </div>
  )
}
