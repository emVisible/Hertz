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
import { GoalSection } from './sections/GoalSection'
import { PipelineSection } from './sections/PipelineSection'
import { SettingsNav, SETTINGS_SECTIONS, type SettingsSection, type SettingsSectionId } from './SettingsNav'
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
  pipeline_video_width?: number
  pipeline_video_height?: number
  pipeline_video_fps?: number
  pipeline_publish_windows?: string
  pipeline_publish_min_interval_min?: number
  pipeline_publish_jitter_min?: number
  pipeline_bili_dtime_min_hours?: number
  pipeline_bili_default_tid?: number
  pipeline_auto_approve?: boolean
  pipeline_auto_approve_after_hours?: number
  pipeline_score_max_per_run?: number
  pipeline_score_max_per_day?: number
  pipeline_narration_lang?: string
  pipeline_tts_rate?: string
  pipeline_narration_min_words?: number
  pipeline_narration_max_words?: number
  pipeline_narration_silent_below?: number
  pipeline_enable_asr?: boolean
  xinference_stt_base_url?: string
  xinference_stt_model_id?: string
  pipeline_download_delay_seconds?: number
  pipeline_download_cooling_base_seconds?: number
  pipeline_download_cooling_max_seconds?: number
  pipeline_cdn_circuit_403?: number
  pipeline_cdn_circuit_cooldown?: number
  pipeline_prefilter_min_reddit_score?: number
  pipeline_prefilter_min_upvote_ratio?: number
  concurrency_llm?: number
  concurrency_image?: number
  concurrency_tts?: number
  concurrency_download?: number
  concurrency_pipeline?: number
  pipeline_integrity_minutes?: number
  pipeline_heuristic_scoring?: boolean
  pipeline_ai_story_per_tick?: number
  pipeline_rss_feeds?: string
  pipeline_strategy_premier_score?: number
  telegram_weekly?: boolean
  scheduler_timezone?: string
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

// 分区清单只有一个作者（`SettingsNav.SETTINGS_SECTIONS`）——导航、这份深链白名单、
// ⌘K 面板从前各写一份，已经漂过一次。这里只从那份派生。
const SECTION_IDS = SETTINGS_SECTIONS.map((s) => s.id)
type SectionId = SettingsSectionId

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
      pipeline_subtitle_margin_bottom: String(cfg.pipeline_subtitle_margin_bottom ?? 64),
      pipeline_video_width: String(cfg.pipeline_video_width ?? 1280),
      pipeline_video_height: String(cfg.pipeline_video_height ?? 720),
      pipeline_video_fps: String(cfg.pipeline_video_fps ?? 30),
      pipeline_publish_windows: cfg.pipeline_publish_windows ?? '10:00-12:00,18:00-20:00',
      pipeline_publish_min_interval_min: String(cfg.pipeline_publish_min_interval_min ?? 30),
      pipeline_publish_jitter_min: String(cfg.pipeline_publish_jitter_min ?? 5),
      pipeline_bili_dtime_min_hours: String(cfg.pipeline_bili_dtime_min_hours ?? 0),
      pipeline_bili_default_tid: String(cfg.pipeline_bili_default_tid ?? 201),
      pipeline_auto_approve: String(cfg.pipeline_auto_approve ?? false),
      pipeline_auto_approve_after_hours: String(cfg.pipeline_auto_approve_after_hours ?? 12),
      pipeline_score_max_per_run: String(cfg.pipeline_score_max_per_run ?? 50),
      pipeline_score_max_per_day: String(cfg.pipeline_score_max_per_day ?? 100),
      pipeline_narration_lang: cfg.pipeline_narration_lang ?? 'en-US',
      pipeline_tts_rate: cfg.pipeline_tts_rate ?? '+0%',
      pipeline_narration_min_words: String(cfg.pipeline_narration_min_words ?? 6),
      pipeline_narration_max_words: String(cfg.pipeline_narration_max_words ?? 42),
      pipeline_narration_silent_below: String(cfg.pipeline_narration_silent_below ?? 8),
      pipeline_enable_asr: String(cfg.pipeline_enable_asr ?? true),
      xinference_stt_base_url: cfg.xinference_stt_base_url ?? '',
      xinference_stt_model_id: cfg.xinference_stt_model_id ?? '',
      pipeline_download_delay_seconds: String(cfg.pipeline_download_delay_seconds ?? 1.2),
      pipeline_download_cooling_base_seconds: String(cfg.pipeline_download_cooling_base_seconds ?? 300),
      pipeline_download_cooling_max_seconds: String(cfg.pipeline_download_cooling_max_seconds ?? 7200),
      pipeline_cdn_circuit_403: String(cfg.pipeline_cdn_circuit_403 ?? 3),
      pipeline_cdn_circuit_cooldown: String(cfg.pipeline_cdn_circuit_cooldown ?? 600),
      pipeline_prefilter_min_reddit_score: String(cfg.pipeline_prefilter_min_reddit_score ?? 50),
      pipeline_prefilter_min_upvote_ratio: String(cfg.pipeline_prefilter_min_upvote_ratio ?? 0.85),
      concurrency_llm: String(cfg.concurrency_llm ?? 4),
      concurrency_image: String(cfg.concurrency_image ?? 2),
      concurrency_tts: String(cfg.concurrency_tts ?? 2),
      concurrency_download: String(cfg.concurrency_download ?? 3),
      concurrency_pipeline: String(cfg.concurrency_pipeline ?? 2),
      pipeline_integrity_minutes: String(cfg.pipeline_integrity_minutes ?? 720),
      pipeline_heuristic_scoring: String(cfg.pipeline_heuristic_scoring ?? true),
      pipeline_ai_story_per_tick: String(cfg.pipeline_ai_story_per_tick ?? 2),
      pipeline_rss_feeds: cfg.pipeline_rss_feeds ?? '',
      pipeline_strategy_premier_score: String(cfg.pipeline_strategy_premier_score ?? 8),
      telegram_weekly: String(cfg.telegram_weekly ?? true),
      scheduler_timezone: cfg.scheduler_timezone ?? '',
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

  /** 分区清单只有一份（`SETTINGS_SECTIONS`）；badge 是各分区自己的判据，留在这里。 */
  const badgeOf = (id: SettingsSectionId): string | undefined => {
    if (id === 'ai') {
      return providers.some((p) => p.enabled) ? t('settings.configured') : t('settings.unconfigured')
    }
    if (id === 'norms') return form.creator_norms || form.standing_plan ? t('settings.configured') : undefined
    return undefined
  }
  const sections: SettingsSection[] = SETTINGS_SECTIONS.map((s) => ({
    id: s.id,
    icon: s.icon,
    label: s.labelKey,
    badge: badgeOf(s.id),
  }))

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

            {sectionId === 'goal' && <GoalSection />}

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