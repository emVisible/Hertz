import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

import { api } from '../../api'
import { aiRegistryApi } from '../../api/ai'
import { Badge, Button, Icon, Input, QueryErrorState, Select, useToast } from '../../components/ui'
import { setLanguage } from '../../i18n'
import { useThemeStore, type Theme } from '../../stores/theme'
import { ProviderManager } from './ProviderManager'
import { PromptsManager } from './PromptsManager'
import { RolesManager } from './RolesManager'
import { SettingsNav, type SettingsSection } from './SettingsNav'
import { TracePanel } from './TracePanel'

interface ConfigData {
  data_dir?: string
  output_dir?: string
  log_dir?: string
  assets_root?: string | null
  pipeline_min_score?: number
  pipeline_collect_limit?: number
  pipeline_publish_target?: string
  llm_api_key_masked?: string | null
  llm_api_key_set?: boolean
}

const SECTION_IDS = ['general', 'ai', 'prompts', 'trace', 'pipeline'] as const
type SectionId = (typeof SECTION_IDS)[number]

const section = 'border border-border bg-surface-1/60 p-4'
const heading = 'mb-1 flex items-center gap-2 text-sm font-semibold text-text-primary'
const sub = 'mb-3 text-xs leading-relaxed text-text-disabled'

/** 路径输入 + 系统目录选择按钮（桌面端经 Electron 呼出 Finder/资源管理器）。 */
function PathField({
  label,
  value,
  onChange,
  onBrowse,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  onBrowse: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="flex items-end gap-1.5">
      <div className="min-w-0 flex-1">
        <Input label={label} value={value} onChange={(e) => onChange(e.target.value)} />
      </div>
      {window.electron?.pickDirectory ? (
        <Button size="sm" variant="secondary" onClick={onBrowse} title={t('settings.browse')}>
          <Icon name="folder" size={13} />
          {t('settings.browse')}
        </Button>
      ) : null}
    </div>
  )
}

export function SettingsPage() {
  const { t, i18n } = useTranslation()
  const toast = useToast()
  const theme = useThemeStore((s) => s.theme)
  const setTheme = useThemeStore((s) => s.setTheme)

  const { data: cfg, isError, refetch } = useQuery({
    queryKey: ['config'],
    queryFn: () => api.get<ConfigData>('/api/config'),
  })
  const { data: providers = [] } = useQuery({
    queryKey: ['ai-providers'],
    queryFn: aiRegistryApi.listProviders,
  })

  const [form, setForm] = useState<Record<string, string>>({})
  const [dirty, setDirty] = useState(false)
  // ⌘K 命令面板深链：?section=ai 直达对应设置分区（v0.2.3）。
  // 同路由重复导航不重挂载 → 用 effect 响应参数变化（§35 数据驱动）
  const [searchParams] = useSearchParams()
  const [sectionId, setSectionId] = useState<SectionId>('general')
  useEffect(() => {
    const section = searchParams.get('section')
    if (section && (SECTION_IDS as readonly string[]).includes(section)) {
      setSectionId(section as SectionId)
    }
  }, [searchParams])

  useEffect(() => {
    if (!cfg) return
    setForm({
      data_dir: cfg.data_dir ?? '',
      output_dir: cfg.output_dir ?? '',
      log_dir: cfg.log_dir ?? '',
      assets_root: cfg.assets_root ?? '',
      pipeline_min_score: String(cfg.pipeline_min_score ?? 6),
      pipeline_collect_limit: String(cfg.pipeline_collect_limit ?? 25),
      pipeline_publish_target: cfg.pipeline_publish_target ?? 'noop',
    })
  }, [cfg])

  function set<K extends keyof typeof form>(key: K, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }))
    setDirty(true)
  }

  async function save() {
    const overrides: Record<string, unknown> = {
      data_dir: form.data_dir?.trim(),
      output_dir: form.output_dir?.trim(),
      log_dir: form.log_dir?.trim(),
      assets_root: form.assets_root?.trim() || null,
      pipeline_min_score: Number(form.pipeline_min_score),
      pipeline_collect_limit: Number(form.pipeline_collect_limit),
      pipeline_publish_target: form.pipeline_publish_target,
    }
    try {
      await api.patch('/api/config', { overrides })
      setDirty(false)
      await refetch()
      toast(t('settings.saved'), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  /** 系统目录选择（Electron 桌面场景）；浏览器降级为手动输入提示。 */
  async function pickPath(key: keyof typeof form) {
    if (!window.electron?.pickDirectory) return
    const current = (form[key] ?? '') as string
    try {
      const picked = await window.electron.pickDirectory(current)
      if (picked) set(key, picked)
    } catch (err) {
      // §4.4 异步失败不沉默：IPC 异常给出可读提示，手动输入仍可用
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  if (isError) {
    return <QueryErrorState message={t('error.queryFailed', { detail: 'config' })} onRetry={() => void refetch()} />
  }

  const sections: SettingsSection[] = [
    { id: 'general', icon: 'moon', label: 'settings.general' },
    { id: 'ai', icon: 'studio', label: 'settings.ai', badge: providers.some((p) => p.enabled) ? t('settings.configured') : t('settings.unconfigured') },
    { id: 'prompts', icon: 'pen', label: 'settings.prompts' },
    { id: 'trace', icon: 'console', label: 'settings.usage' },
    { id: 'pipeline', icon: 'config', label: 'settings.pipeline' },
  ]

  return (
    <div className="flex h-full min-h-0 overflow-hidden p-6">
      <div className="mx-auto flex w-full max-w-5xl gap-6">
        <SettingsNav sections={sections} active={sectionId} onChange={(id) => setSectionId(id as SectionId)} />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex flex-col gap-4 pr-1">
            <h1 className="text-base font-semibold text-text-primary">{t('settings.title')}</h1>

            {sectionId === 'general' && (
              <>
                <section className={section}>
                  <h2 className={heading}>
                    <Icon name="moon" size={15} />
                    {t('settings.general')}
                  </h2>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Select
                      label={t('settings.language')}
                      value={i18n.language}
                      onChange={(e) => setLanguage(e.target.value as 'zh' | 'en')}
                      options={[
                        { value: 'zh', label: '中文' },
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

                <section className={section}>
                  <h2 className={heading}>
                    <Icon name="folder" size={15} />
                    {t('settings.paths')}
                  </h2>
                  <div className="mt-2 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    <PathField label={t('settings.dataDir')} value={form.data_dir ?? ''} onChange={(v) => set('data_dir', v)} onBrowse={() => void pickPath('data_dir')} />
                    <PathField label={t('settings.outputDir')} value={form.output_dir ?? ''} onChange={(v) => set('output_dir', v)} onBrowse={() => void pickPath('output_dir')} />
                    <PathField label={t('settings.logDir')} value={form.log_dir ?? ''} onChange={(v) => set('log_dir', v)} onBrowse={() => void pickPath('log_dir')} />
                  </div>
                  <div className="mt-2 grid gap-3 sm:grid-cols-2">
                    <PathField label={t('settings.assetsRoot')} value={form.assets_root ?? ''} onChange={(v) => set('assets_root', v)} onBrowse={() => void pickPath('assets_root')} />
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
            )}

            {sectionId === 'ai' && (
              <>
                <section className={section}>
                  <div className="mb-3 flex items-center justify-between">
                    <h2 className={heading}>
                      <Icon name="studio" size={15} />
                      {t('settings.llm')}
                    </h2>
                    <Badge tone={providers.some((p) => p.enabled) ? 'success' : 'neutral'}>
                      {providers.some((p) => p.enabled) ? t('settings.configured') : t('settings.unconfigured')}
                    </Badge>
                  </div>
                  <p className={sub}>{t('settings.llmHint')}</p>
                  <ProviderManager />
                </section>

                <section className={section}>
                  <div className="mb-2 flex items-center gap-2">
                    <Icon name="box" size={15} />
                    <h2 className="text-sm font-semibold text-text-primary">{t('settings.models')}</h2>
                  </div>
                  <RolesManager />
                </section>
              </>
            )}

            {sectionId === 'prompts' && (
              <section className={section}>
                <h2 className={heading}>
                  <Icon name="pen" size={15} />
                  {t('settings.prompts')}
                </h2>
                <div className="mt-3">
                  <PromptsManager />
                </div>
              </section>
            )}

            {sectionId === 'trace' && (
              <section className={section}>
                <h2 className={heading}>
                  <Icon name="console" size={15} />
                  {t('settings.usage')}
                </h2>
                <div className="mt-3">
                  <TracePanel />
                </div>
              </section>
            )}

            {sectionId === 'pipeline' && (
              <>
                <section className={section}>
                  <h2 className={heading}>
                    <Icon name="config" size={15} />
                    {t('settings.pipeline')}
                  </h2>
                  <div className="mt-2 grid gap-3 sm:grid-cols-3">
                    <Input
                      label={t('settings.minScore')}
                      type="number"
                      step="0.1"
                      value={form.pipeline_min_score ?? '6'}
                      onChange={(e) => set('pipeline_min_score', e.target.value)}
                    />
                    <Input
                      label={t('settings.collectLimit')}
                      type="number"
                      value={form.pipeline_collect_limit ?? '25'}
                      onChange={(e) => set('pipeline_collect_limit', e.target.value)}
                    />
                    <Select
                      label={t('settings.publishTarget')}
                      value={form.pipeline_publish_target ?? 'noop'}
                      onChange={(e) => set('pipeline_publish_target', e.target.value)}
                      options={[
                        { value: 'noop', label: 'noop' },
                        { value: 'bilibili', label: 'Bilibili' },
                      ]}
                    />
                  </div>
                </section>

                <div className="flex justify-end gap-2">
                  <Button onClick={save} disabled={!dirty}>
                    <Icon name="check" size={14} />
                    {t('settings.save')}
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
