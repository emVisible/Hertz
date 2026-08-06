import { useTranslation } from 'react-i18next'

import { Badge, Icon } from '../../components/ui'

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
