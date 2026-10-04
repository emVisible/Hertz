import { useTranslation } from 'react-i18next'

import { Badge, Icon } from '../../components/ui'

/** 设置分区清单（v0.34）——**唯一作者**：左栏导航、`?section=` 深链白名单、⌘K 面板三处都读这份。
 *
 * 为什么收成一份：这三处从前各写一份字面量，实测已经漂过——`norms` 加进左栏导航时
 * ⌘K 面板那份没跟着加，于是「命令面板里搜不到的分区」和「设置页真实存在的分区」是两个答案。
 * 判据在 `pages/settings/sections.test.ts`。
 */
export const SETTINGS_SECTIONS = [
  { id: 'general', icon: 'moon', labelKey: 'settings.general' },
  { id: 'ai', icon: 'studio', labelKey: 'settings.ai' },
  { id: 'norms', icon: 'library', labelKey: 'settings.navNorms' },
  { id: 'goal', icon: 'pin', labelKey: 'settings.navGoal' },
  { id: 'prompts', icon: 'pen', labelKey: 'settings.prompts' },
  { id: 'trace', icon: 'console', labelKey: 'settings.usage' },
  { id: 'pipeline', icon: 'config', labelKey: 'settings.pipeline' },
] as const

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id']

/** 设置页左栏导航项。 */
export interface SettingsSection {
  id: string
  icon: string
  label: string
  badge?: string
}

export function SettingsNav({
  sections,
  active,
  onChange,
}: {
  sections: SettingsSection[]
  active: string
  onChange: (id: string) => void
}) {
  const { t } = useTranslation()
  return (
    <nav className="flex w-44 shrink-0 flex-col gap-0.5 border-r border-border pr-2">
      {sections.map((s) => {
        const selected = s.id === active
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => onChange(s.id)}
            className={`flex items-center gap-2 rounded px-2.5 py-2 text-left text-sm transition-colors ${
              selected
                ? 'bg-surface-2 font-medium text-text-primary'
                : 'text-text-secondary hover:bg-surface-2/60 hover:text-text-primary'
            }`}
          >
            <Icon name={s.icon as never} size={14} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate">{t(s.label)}</span>
            {s.badge && <Badge tone="neutral">{s.badge}</Badge>}
          </button>
        )
      })}
    </nav>
  )
}
