/** Settings 通用区（v0.20 拆分）：系统健康看板 / 语言与主题 / 系统路径。
 *  纯结构移动自 SettingsPage，零行为变化。 */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'

import { setLanguage } from '../../../i18n'
import { Button, Icon, Select } from '../../../components/ui'
import { useThemeStore, type Theme } from '../../../stores/theme'
import { api } from '../../../api/client'
import { HealthDashboard } from '../HealthDashboard'
import { PathField, type SectionProps } from './shared'

/**
 * 剪贴板监控开关。
 *
 * 与其他设置项不同，这个**不靠保存生效**：Electron 主进程每 1.5s 轮询一次系统
 * 剪贴板，用户点了开关却还要再点一次「保存」、期间监控仍在跑——那等于没给开关。
 * 所以这里立刻通过 IPC 通知主进程起停，同时照常存进设置（重启后仍生效）。
 *
 * 非 Electron 环境（纯浏览器）没有 `window.electron`，此时只存配置不报错。
 */
function ClipboardMonitorToggle() {
  const { t } = useTranslation()
  const { data: cfg } = useQuery({
    queryKey: ['config'],
    queryFn: () => api.get<{ clipboard_monitor_enabled?: boolean }>('/api/config'),
  })
  const [on, setOn] = useState(() => cfg?.clipboard_monitor_enabled ?? true)

  useEffect(() => {
    if (cfg?.clipboard_monitor_enabled != null) setOn(cfg.clipboard_monitor_enabled)
  }, [cfg?.clipboard_monitor_enabled])

  // 拿到配置后立刻与主进程对齐一次：主进程默认是开启的，
  // 而用户可能早就关过——不主动同步就会「关了但还在监控」。
  useEffect(() => {
    if (cfg?.clipboard_monitor_enabled == null) return
    window.electron?.setClipboardMonitor?.(cfg.clipboard_monitor_enabled)
  }, [cfg?.clipboard_monitor_enabled])

  function toggle() {
    const next = !on
    setOn(next)
    window.electron?.setClipboardMonitor?.(next)
    void api.patch('/api/config', { overrides: { clipboard_monitor_enabled: next } })
  }

  return (
    <button
      type="button"
      onClick={toggle}
      className="flex w-full items-start gap-2.5 rounded border border-border px-3 py-2 text-left hover:bg-surface-2/50"
    >
      <span
        className={`mt-0.5 flex h-4 w-7 shrink-0 items-center rounded-full px-0.5 transition-colors ${
          on ? 'bg-primary' : 'bg-surface-2'
        }`}
      >
        <span className={`h-3 w-3 rounded-full bg-surface-1 transition-transform ${on ? 'translate-x-3' : ''}`} />
      </span>
      <span className="min-w-0">
        <span className="block text-xs font-medium text-text-primary">
          {t('settings.clipboardMonitor')}
        </span>
        <span className="mt-0.5 block text-[11px] leading-relaxed text-text-disabled">
          {t('settings.clipboardMonitorHint')}
        </span>
      </span>
    </button>
  )
}

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

      <section className="border border-border bg-surface-1/60 p-4">
        <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-text-primary">
          <Icon name="config" size={15} />
          {t('settings.privacy')}
        </h2>
        <div className="mt-2">
          <ClipboardMonitorToggle />
        </div>
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
