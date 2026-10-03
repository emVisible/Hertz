/** Settings 页主壳（v0.20 拆分后）：nav + 表单草稿中枢 + save + 分区路由。
 *  各分区 UI 在 sections/ 目录（General/Ai/Pipeline），prompts/trace 为薄壳。 */

import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

import { api } from '../../api'
import { aiRegistryApi } from '../../api/ai'
import { Icon, QueryErrorState, useToast } from '../../components/ui'
import { PromptsManager } from './PromptsManager'
import { TracePanel } from './TracePanel'
import { GeneralSection } from './sections/GeneralSection'
import { AiSection } from './sections/AiSection'
import { NormsSection } from './sections/NormsSection'
import { PipelineSection } from './sections/PipelineSection'
import { SettingsNav, type SettingsSection } from './SettingsNav'
import { buildOverrides } from '../../core/settingsOverrides'

interface ConfigData {
  data_dir?: string
  output_dir?: string
  log_dir?: string
  assets_root?: string | null
  pipeline_min_score?: number
  pipeline_collect_limit?: number
  pipeline_auto_collect_minutes?: number
  pipeline_publish_target?: string
  /** 自动发布队列（v0.12）：总开关 / 每日产能上限 / 预发布每日转正数 / tick 间隔 */
  pipeline_auto_publish?: boolean
  pipeline_auto_publish_daily_limit?: number
  pipeline_strategy_enabled?: boolean
  pipeline_strategy_dry_run?: boolean
  pipeline_strategy_base_daily?: number
  pipeline_strategy_warmup_floor?: number
  pipeline_strategy_warmup_step?: number
  pipeline_strategy_drop_ratio?: number
  pipeline_strategy_cooldown_floor_views?: number
  pipeline_strategy_cooldown_streak_days?: number
  pipeline_strategy_min_same_tid_gap_h?: number
  pipeline_auto_promote_daily?: number
  pipeline_auto_publish_tick_minutes?: number
  pipeline_sources?: string[]
  pipeline_watch_enabled?: boolean
  pipeline_watch_subreddits?: string
  pipeline_watch_sort?: string
  pipeline_watch_minutes?: number
  pipeline_watch_keywords_any?: string
  pipeline_watch_keywords_all?: string
  pipeline_watch_exclude?: string
  pipeline_watch_min_score?: number
  telegram_enabled?: boolean
  telegram_bot_token?: string
  telegram_chat_id?: string
  telegram_minutes?: number
  pipeline_subtitle_font_size?: number
  pipeline_subtitle_outline?: number
  pipeline_subtitle_bold?: boolean
  pipeline_subtitle_alignment?: number
  pipeline_subtitle_fade_ms?: number
  pipeline_subtitle_margin_bottom?: number
  pipeline_subtitle_lang?: string
  pipeline_translate_source_lang?: string
  pipeline_tts_text_source?: string
  /** 本地模型下载端点 + 转写档位（v0.32 S4）：不设草稿 = 保存时被静默丢掉 */
  pipeline_hf_endpoint?: string
  pipeline_whisper_model?: string
  pipeline_reddit_client_id?: string
  pipeline_reddit_client_id_set?: boolean
  pipeline_reddit_cookie?: string
  pipeline_reddit_cookies_browser?: string
  pipeline_reddit_client_secret_set?: boolean
  ai_model_prices?: Record<string, { prompt?: number; completion?: number }>
  cost_currency?: string
  cost_usd_rate?: number
  cost_monthly_budget?: number
  channel_persona?: string
  /** 运营者自用规范与固定计划（v0.34）：只给人看，不进任何 prompt */
  creator_norms?: string
  standing_plan?: string
  llm_api_key_masked?: string | null
  llm_api_key_set?: boolean
}

const SECTION_IDS = ['general', 'ai', 'norms', 'prompts', 'trace', 'pipeline'] as const
type SectionId = (typeof SECTION_IDS)[number]

export function SettingsPage() {
  const { t } = useTranslation()
  const toast = useToast()

  const { data: providers = [] } = useQuery({
    queryKey: ['ai-providers'],
    queryFn: aiRegistryApi.listProviders,
  })
  const { data: cfg, isError, refetch } = useQuery({
    queryKey: ['config'],
    queryFn: () => api.get<ConfigData>('/api/config'),
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

  // 表单草稿初始化（v0.20 精简注释：字段全集与 save() 一一对应）
  useEffect(() => {
    if (!cfg) return
    setForm({
      data_dir: cfg.data_dir ?? '',
      output_dir: cfg.output_dir ?? '',
      log_dir: cfg.log_dir ?? '',
      assets_root: cfg.assets_root ?? '',
      pipeline_min_score: String(cfg.pipeline_min_score ?? 6),
      pipeline_collect_limit: String(cfg.pipeline_collect_limit ?? 25),
      pipeline_auto_collect_minutes: String(cfg.pipeline_auto_collect_minutes ?? 30),
      pipeline_watch_enabled: String(cfg.pipeline_watch_enabled ?? false),
      pipeline_watch_subreddits: cfg.pipeline_watch_subreddits ?? '',
      pipeline_watch_sort: cfg.pipeline_watch_sort ?? 'rising',
      pipeline_watch_minutes: String(cfg.pipeline_watch_minutes ?? 15),
      pipeline_watch_keywords_any: cfg.pipeline_watch_keywords_any ?? '',
      pipeline_watch_keywords_all: cfg.pipeline_watch_keywords_all ?? '',
      pipeline_watch_exclude: cfg.pipeline_watch_exclude ?? '',
      pipeline_watch_min_score: String(cfg.pipeline_watch_min_score ?? 0),
      channel_persona: cfg.channel_persona ?? '',
      creator_norms: cfg.creator_norms ?? '',
      standing_plan: cfg.standing_plan ?? '',
      telegram_enabled: String(cfg.telegram_enabled ?? false),
      telegram_bot_token: cfg.telegram_bot_token ?? '',
      telegram_chat_id: cfg.telegram_chat_id ?? '',
      telegram_minutes: String(cfg.telegram_minutes ?? 1),
      pipeline_publish_target: cfg.pipeline_publish_target ?? 'noop',
      pipeline_auto_publish: String(cfg.pipeline_auto_publish ?? false),
      pipeline_auto_publish_daily_limit: String(cfg.pipeline_auto_publish_daily_limit ?? 5),
      pipeline_auto_promote_daily: String(cfg.pipeline_auto_promote_daily ?? 3),
      pipeline_auto_publish_tick_minutes: String(cfg.pipeline_auto_publish_tick_minutes ?? 5),
      pipeline_strategy_enabled: String(cfg.pipeline_strategy_enabled ?? false),
      pipeline_strategy_dry_run: String(cfg.pipeline_strategy_dry_run ?? false),
      pipeline_strategy_base_daily: String(cfg.pipeline_strategy_base_daily ?? 2),
      pipeline_strategy_warmup_floor: String(cfg.pipeline_strategy_warmup_floor ?? 30),
      pipeline_strategy_warmup_step: String(cfg.pipeline_strategy_warmup_step ?? 10),
      pipeline_strategy_drop_ratio: String(cfg.pipeline_strategy_drop_ratio ?? 0.5),
      pipeline_strategy_cooldown_floor_views: String(cfg.pipeline_strategy_cooldown_floor_views ?? 10),
      pipeline_strategy_cooldown_streak_days: String(cfg.pipeline_strategy_cooldown_streak_days ?? 2),
      pipeline_strategy_min_same_tid_gap_h: String(cfg.pipeline_strategy_min_same_tid_gap_h ?? 6),
      pipeline_sources: ((cfg as Record<string, unknown>).pipeline_sources as string[] | undefined ?? ['hot']).join(', '),
      pipeline_subtitle_font_size: String(cfg.pipeline_subtitle_font_size ?? 24),
      pipeline_subtitle_outline: String(cfg.pipeline_subtitle_outline ?? 1),
      pipeline_subtitle_bold: String(cfg.pipeline_subtitle_bold ?? false),
      pipeline_subtitle_alignment: String(cfg.pipeline_subtitle_alignment ?? 2),
      pipeline_subtitle_fade_ms: String(cfg.pipeline_subtitle_fade_ms ?? 300),
      pipeline_subtitle_margin_bottom: String(cfg.pipeline_subtitle_margin_bottom ?? 72),
      pipeline_subtitle_lang: cfg.pipeline_subtitle_lang ?? 'zh-CN',
      pipeline_translate_source_lang: cfg.pipeline_translate_source_lang ?? 'en-US',
      pipeline_tts_text_source: cfg.pipeline_tts_text_source ?? 'script',
      pipeline_hf_endpoint: cfg.pipeline_hf_endpoint ?? '',
      pipeline_whisper_model: cfg.pipeline_whisper_model ?? 'base',
      pipeline_reddit_client_id: cfg.pipeline_reddit_client_id ?? '',
      pipeline_reddit_client_secret: '',
      pipeline_reddit_cookie: '',
      pipeline_reddit_cookies_browser: (cfg as Record<string, unknown>).pipeline_reddit_cookies_browser as string ?? '',
    })
  }, [cfg])

  async function save() {
    try {
      await api.patch('/api/config', { overrides: buildOverrides(cfg, form) })
      setDirty(false)
      await refetch()
      toast(t('settings.saved'), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  function set(key: string, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }))
    setDirty(true)
  }

  async function pickPath(key: string) {
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

  const sectionWrap = 'flex flex-col gap-4'

  if (isError) {
    return <QueryErrorState message={t('error.queryFailed', { detail: 'config' })} onRetry={() => void refetch()} />
  }

  const sections: SettingsSection[] = [
    { id: 'general', icon: 'moon', label: 'settings.general' },
    { id: 'ai', icon: 'studio', label: 'settings.ai', badge: providers.some((p) => p.enabled) ? t('settings.configured') : t('settings.unconfigured') },
    {
      id: 'norms',
      icon: 'library',
      label: 'settings.navNorms',
      badge: form.creator_norms || form.standing_plan ? t('settings.configured') : undefined,
    },
    { id: 'prompts', icon: 'pen', label: 'settings.prompts' },
    { id: 'trace', icon: 'console', label: 'settings.usage' },
    { id: 'pipeline', icon: 'config', label: 'settings.pipeline' },
  ]

  return (
    // v0.22 修复：恢复自管滚动（v0.20 拆分时丢失——main overflow-hidden 下
    // 无滚动容器导致设置页内容被裁剪不可滚；老版结构为 nav 外置 + 内容区
    // min-h-0 flex-1 overflow-y-auto）
    <div className="mx-auto flex h-full w-full max-w-5xl flex-col px-6 py-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold text-text-primary">{t('settings.title')}</h1>
      </div>
      <div className="flex min-h-0 flex-1 gap-6">
        <aside className="w-44 shrink-0">
          <SettingsNav sections={sections} active={sectionId} onChange={(id) => setSectionId(id as SectionId)} />
        </aside>
        <div className="min-w-0 flex-1 overflow-y-auto pr-1">
          <div className={sectionWrap}>
            {sectionId === 'general' && (
              <GeneralSection form={form} set={set} save={save} dirty={dirty} pickPath={pickPath} />
            )}

            {sectionId === 'ai' && (
              <AiSection form={form} set={set} />
            )}

            {sectionId === 'norms' && (
              <NormsSection form={form} set={set} save={save} dirty={dirty} />
            )}

            {sectionId === 'prompts' && (
              <section className="border border-border bg-surface-1/60 p-4">
                <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-text-primary">
                  <Icon name="pen" size={15} />
                  {t('settings.prompts')}
                </h2>
                <div className="mt-3">
                  <PromptsManager />
                </div>
              </section>
            )}

            {sectionId === 'trace' && (
              <section className="border border-border bg-surface-1/60 p-4">
                <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-text-primary">
                  <Icon name="console" size={15} />
                  {t('settings.usage')}
                </h2>
                <div className="mt-3">
                  <TracePanel />
                </div>
              </section>
            )}

            {sectionId === 'pipeline' && (
              <PipelineSection
                form={form}
                set={set}
                save={save}
                dirty={dirty}
                pickPath={pickPath}
                cfg={cfg}
                refetchConfig={() => void refetch()}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}