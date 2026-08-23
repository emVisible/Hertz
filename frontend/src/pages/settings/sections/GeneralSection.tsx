/** Settings 通用区（v0.20 拆分）：系统健康看板 / 语言与主题 / 系统路径。
 *  纯结构移动自 SettingsPage，零行为变化。 */

import { useTranslation } from 'react-i18next'

import { setLanguage } from '../../../i18n'
import { Button, Icon, Select } from '../../../components/ui'
import { useThemeStore, type Theme } from '../../../stores/theme'
import { HealthDashboard } from '../HealthDashboard'
import { PathField, type SectionProps } from './shared'

export function GeneralSection({ form, set, save, dirty, pickPath }: SectionProps) {
  const { t } = useTranslation()
  const theme = useThemeStore((s) => s.theme)
  const setTheme = useThemeStore((s) => s.setTheme)

  return (
    <>
      <section className="border border-border bg-surface-1/60 p-4">
        <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-text-primary">
          <Icon name="config" size={15} />
          {t('settings.health')}
        </h2>
        {/* 系统健康看板（v0.11.6）：/api/health 可视化 */}
        <div className="mt-2">
          <HealthDashboard />
        </div>
      </section>

      <section className="border border-border bg-surface-1/60 p-4">
        <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-text-primary">
          <Icon name="moon" size={15} />
          {t('settings.general')}
        </h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Select
            label={t('settings.language')}
            value={useTranslation().i18n.language}
            onChange={(e) => setLanguage(e.target.value as 'zh' | 'en')}
            options={[
              { value: 'zh', label: t('settings.langZh') },
              { value: 'en', label: 'English' },
            ]}
          />
          <Select
            label={t('settings.theme')}
            value={theme}
            onChange={(e) => setTheme(e.target.value as Theme)}
            options={[
              { value: 'dark', label: t('theme.dark') },
              { value: 'light', label: t('theme.light') },
            ]}
          />
        </div>
      </section>

      <section className="border border-border bg-surface-1/60 p-4">
        <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-text-primary">
          <Icon name="folder" size={15} />
          {t('settings.paths')}
        </h2>
        <div className="mt-2 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <PathField label={t('settings.dataDir')} value={form.data_dir ?? ''} onChange={(v) => set('data_dir', v)} onBrowse={() => void pickPath("data_dir")} />
          <PathField label={t('settings.outputDir')} value={form.output_dir ?? ''} onChange={(v) => set('output_dir', v)} onBrowse={() => void pickPath("output_dir")} />
          <PathField label={t('settings.logDir')} value={form.log_dir ?? ''} onChange={(v) => set('log_dir', v)} onBrowse={() => void pickPath("log_dir")} />
        </div>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <PathField label={t('settings.assetsRoot')} value={form.assets_root ?? ''} onChange={(v) => set('assets_root', v)} onBrowse={() => void pickPath("assets_root")} />
        </div>
        <p className="mt-1.5 text-xs leading-relaxed text-text-disabled">{t('settings.assetsRootHint')}</p>
      </section>

      <div className="flex justify-end gap-2">
        <Button onClick={save} disabled={!dirty}>
          <Icon name="check" size={14} />
          {t('settings.save')}
        </Button>
      </div>
    </>
  )
}
