import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

import { api } from '../../api'
import { pipelineApi } from '../../api/pipeline'
import { aiRegistryApi } from '../../api/ai'
import { Badge, Button, Icon, Input, QueryErrorState, Select, useToast } from '../../components/ui'
import { setLanguage } from '../../i18n'
import { useThemeStore, type Theme } from '../../stores/theme'
import { ProviderManager } from './ProviderManager'
import { PromptsManager } from './PromptsManager'
import { RolesManager } from './RolesManager'
import { FeaturesMap } from './FeaturesMap'
import { SettingsNav, type SettingsSection } from './SettingsNav'
import { TracePanel } from './TracePanel'
import { HealthDashboard } from './HealthDashboard'
import { SOURCE_CATALOG_NAMES, SOURCE_GROUPS } from '../../constants/sources'

/** 字幕翻译语言选项（v0.8.9 翻译方向扩展：源→目标可配） */
const LANG_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en-US', label: 'English' },
  { value: 'en-GB', label: 'English (UK)' },
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'vi', label: 'Tiếng Việt' },
  { value: 'id', label: 'Bahasa Indonesia' },
  { value: 'fil', label: 'Filipino' },
  { value: 'pt-BR', label: 'Português (BR)' },
  { value: 'de', label: 'Deutsch' },
  { value: 'fr', label: 'Français' },
  { value: 'es', label: 'Español' },
  { value: 'ar', label: 'العربية' },
  { value: 'ru', label: 'Русский' },
  { value: 'it', label: 'Italiano' },
  { value: 'tr', label: 'Türkçe' },
  { value: 'th', label: 'ภาษาไทย' },
]

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
  pipeline_auto_promote_daily?: number
  pipeline_auto_publish_tick_minutes?: number
  pipeline_sources?: string[]
  pipeline_subtitle_font_size?: number
  pipeline_subtitle_outline?: number
  pipeline_subtitle_bold?: boolean
  pipeline_subtitle_alignment?: number
  pipeline_subtitle_fade_ms?: number
  pipeline_subtitle_margin_bottom?: number
  pipeline_subtitle_lang?: string
  pipeline_translate_source_lang?: string
  pipeline_tts_text_source?: string
  pipeline_reddit_client_id?: string
  pipeline_reddit_client_id_set?: boolean
  pipeline_reddit_cookie?: string
  pipeline_reddit_cookies_browser?: string
  pipeline_reddit_client_secret_set?: boolean
  ai_model_prices?: Record<string, { prompt?: number; completion?: number }>
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

/** Reddit Cookie 状态卡（v0.8.1）：存在性/年龄 + 一键浏览器导出（v0.11.7 可选浏览器 + 通道验证）。 */
const COOKIE_BROWSERS = [
  { value: '', label: 'auto' },
  { value: 'chrome', label: 'Chrome' },
  { value: 'safari', label: 'Safari' },
  { value: 'edge', label: 'Edge' },
  { value: 'firefox', label: 'Firefox' },
]

function RedditCookieCard() {
  const { t } = useTranslation()
  const toast = useToast()
  const { data, isError, refetch } = useQuery({
    queryKey: ['reddit-cookie-status'],
    queryFn: () => api.get<{ exists: boolean; age_s: number | null; path: string; cookie_set: boolean; session_cookie?: boolean }>('/api/pipeline/reddit-cookie/status'),
    refetchInterval: 15_000,
  })
  const [busy, setBusy] = useState(false)
  const [browser, setBrowser] = useState('')

  async function exportCookie(force = false) {
    setBusy(true)
    try {
      const res = await api.post<{ ok: boolean; source: string; session_cookie?: boolean; verify_status?: { ok: boolean; code?: number } }>(
        `/api/pipeline/reddit-cookie/export?force=${force ? 'true' : 'false'}&browser=${encodeURIComponent(browser)}&verify=true`,
      )
      if (res.ok) {
        if (!res.session_cookie) {
          toast(t('settings.cookieExportedNoSession'), 'warning')
        } else if (res.verify_status?.ok) {
          toast(t('settings.cookieExportedVerified', { source: res.source }), 'success')
        } else {
          toast(
            t('settings.cookieExportedBlocked', { source: res.source, code: String(res.verify_status?.code ?? '?') }),
            'warning',
          )
        }
      } else {
        toast(t('settings.cookieExportFailed'), 'warning')
      }
      await refetch()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  const ageH = data?.age_s == null ? null : Math.round(data.age_s / 3600)
  return (
    <div className="mt-2 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge tone={data?.exists ? 'success' : 'warning'}>
          {data?.exists ? t('settings.cookieReady') : t('settings.cookieMissing')}
        </Badge>
        {data?.exists && ageH != null && (
          <span className="text-text-secondary">{t('settings.cookieAge', { h: ageH })}</span>
        )}
        {data?.cookie_set && <Badge tone="neutral">{t('settings.cookieRawSet')}</Badge>}
        {data?.session_cookie ? (
          <Badge tone="success">{t('settings.cookieSessionOk')}</Badge>
        ) : data?.exists ? (
          <Badge tone="warning">{t('settings.cookieNoSession')}</Badge>
        ) : null}
      </div>
      <p className="text-xs leading-relaxed text-text-secondary">
        {t('settings.cookiePath')}:{' '}
        <code className="font-mono text-text-primary">{data?.path ?? '…'}</code>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={browser}
          onChange={(e) => setBrowser(e.target.value)}
          className="w-36"
          options={COOKIE_BROWSERS}
        />
        <Button size="sm" onClick={() => void exportCookie()} loading={busy}>
          <Icon name="downloads" size={12} />
          {t('settings.cookieExport')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void exportCookie(true)} disabled={busy}>
          {t('settings.cookieExportForce')}
        </Button>
      </div>
      {isError && <p className="text-xs text-error">{t('error.queryFailed', { detail: 'cookie' })}</p>}
    </div>
  )
}

/** B 站发布就绪状态（v0.3.8）：目标 + cookie 检查 + 登录引导。 */
function DepsCard() {
  const { t } = useTranslation()
  const toast = useToast()
  const { data, refetch, isFetching } = useQuery({
    queryKey: ['deps-status'],
    queryFn: () => api.get<Record<string, Record<string, unknown>>>('/api/deps'),
  })

  async function recheck() {
    try {
      await api.post<Record<string, Record<string, unknown>>>('/api/deps/check')
      toast(t('settings.depsChecked'), 'success')
      await refetch()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  // v0.8.9：安装指引由后端检测结果提供（install_hint，单一真相源）——
  // 前端不再硬编码安装命令；缺失/降级项行内可见展示
  const rows = ['ffmpeg', 'ffprobe', 'biliup', 'yt-dlp', 'edge-tts']
  const ff = data?.ffmpeg as { status?: string; libass?: boolean; version?: string } | undefined

  return (
    <div className="mt-2 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        {rows.map((key) => {
          const d = (data?.[key] as { status?: string; path?: string } | undefined) ?? {}
          const ok = d.status === 'ok'
          return (
            <span
              key={key}
              title={ok ? (d.path ?? '') : undefined}
              className={`flex items-center gap-1.5 border px-2 py-1 text-[11px] ${
                ok ? 'border-border text-text-secondary' : 'border-error/40 text-error'
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${ok ? 'bg-success' : 'bg-error'}`} />
              {key}
            </span>
          )
        })}
        <span className="ml-auto font-mono text-[10px] text-text-disabled">
          {t('settings.depsCheckedAt', { t: (data?.checked_at as string | undefined)?.slice(5, 19).replace('T', ' ') ?? '—' })}
        </span>
      </div>

      {/* 缺失项安装指引（v0.8.9）：逐项可见展示 install_hint，可选中复制 */}
      {rows.map((key) => {
        const d = (data?.[key] as { status?: string; install_hint?: string } | undefined) ?? {}
        if (d.status === 'ok' || !d.install_hint) return null
        return (
          <p key={key} className="flex items-center gap-2 text-xs leading-relaxed text-error">
            <span className="shrink-0">{key}：</span>
            <code className="select-all rounded bg-surface-2 px-2 py-0.5 font-mono text-[11px] text-text-primary">
              {d.install_hint}
            </code>
          </p>
        )
      })}

      {/* libass 降级警示 + 安装命令（官方 brew 版无 libass——需社区完整版 tap） */}
      {ff?.status === 'ok' && !ff.libass && (
        <p className="flex items-center gap-2 text-xs leading-relaxed text-warning">
          <span className="shrink-0">{t('settings.depsLibassHint')}：</span>
          <code className="select-all rounded bg-surface-2 px-2 py-0.5 font-mono text-[11px] text-text-primary">
            brew install homebrew-ffmpeg/ffmpeg/ffmpeg
          </code>
        </p>
      )}
      <Button size="sm" variant="secondary" onClick={() => void recheck()} disabled={isFetching}>
        <Icon name="refresh" size={12} />
        {t('settings.depsRecheck')}
      </Button>
    </div>
  )
}

/** B 站发布就绪状态（v0.3.8）：目标 + cookie 检查 + 登录引导。 */
function PublishStatusCard({ onChanged }: { onChanged: () => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const { data, isError, refetch } = useQuery({
    queryKey: ['pipeline-publish-status'],
    queryFn: pipelineApi.publishStatus,
    refetchInterval: 15_000,
  })

  if (isError || !data) {
    return (
      <p className="text-xs text-text-disabled">
        {isError ? t('error.queryFailed', { detail: 'publish status' }) : '…'}
      </p>
    )
  }

  const age = data.cookie_age_s == null ? null : Math.round(data.cookie_age_s / 3600)

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge tone={data.noop ? 'warning' : 'success'}>{data.target}</Badge>
        {data.target === 'bilibili' && (
          <span className="flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-full ${data.cookie_exists ? 'bg-success' : 'bg-error'}`} />
            <span className="text-text-secondary">
              {data.cookie_exists
                ? `${t('settings.cookieReady')}${age != null ? t('settings.hoursAgo', { n: age }) : ''}`
                : t('settings.cookieMissing')}
            </span>
          </span>
        )}
        {data.target === 'bilibili' && !data.biliup_available && (
          <Badge tone="warning">{t('settings.biliupMissing')}</Badge>
        )}
      </div>
      {data.noop && (
        <p className="text-xs leading-relaxed text-warning">{t('settings.publishNoopWarn')}</p>
      )}
      {data.target === 'bilibili' && (
        <p className="text-xs leading-relaxed text-text-secondary">
          {t('settings.cookiePath')}: <code className="font-mono text-text-primary">{data.cookie_path}</code>
        </p>
      )}
      {data.target === 'bilibili' && !data.cookie_exists && (
        <p className="text-xs leading-relaxed text-warning">{t('settings.cookiePlaceHint')}</p>
      )}
      {data.target === 'bilibili' && data.cookie_exists && (
        <p className="text-xs leading-relaxed text-text-secondary">{t('settings.cookieAutoRefresh')}</p>
      )}
      {data.target === 'bilibili' && data.cookie_exists && (
        <div className="flex flex-wrap items-center gap-2">
          <code className="select-all rounded bg-surface-2 px-2 py-1 font-mono text-[11px] text-text-primary">
            biliup -u {data.cookie_path} renew
          </code>
          <span className="text-[11px] text-text-disabled">{t('settings.cookieRenewOptional')}</span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              void refetch().then(() => {
                toast(t('settings.cookieChecked'), 'success')
                onChanged()
              })
            }}
          >
            <Icon name="refresh" size={12} />
            {t('settings.checkCookie')}
          </Button>
        </div>
      )}
    </div>
  )
}

/** 模型单价配置（v0.5 E 成本估算）：每行 `model_key: prompt价/completion价`（美元/百万 tokens）。 */
function ModelPrices() {
  const { t } = useTranslation()
  const toast = useToast()
  const { data: cfg, refetch } = useQuery({
    queryKey: ['config'],
    queryFn: () => api.get<ConfigData>('/api/config'),
  })
  const [raw, setRaw] = useState('')

  useEffect(() => {
    if (!cfg) return
    const prices = (cfg.ai_model_prices ?? {}) as Record<string, { prompt?: number; completion?: number }>
    setRaw(
      Object.entries(prices)
        .map(([k, v]) => `${k}: ${v?.prompt ?? 0}/${v?.completion ?? 0}`)
        .join('\n'),
    )
  }, [cfg])

  async function save() {
    const prices: Record<string, { prompt: number; completion: number }> = {}
    for (const line of raw.split('\n')) {
      const m = line.trim().match(/^([^\s:]+):\s*([\d.]+)\s*\/\s*([\d.]+)$/)
      if (!m) continue
      prices[m[1]] = { prompt: Number(m[2]), completion: Number(m[3]) }
    }
    try {
      await api.patch('/api/config', { overrides: { ai_model_prices: prices } })
      await refetch()
      toast(t('settings.saved'), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-text-secondary">{t('settings.pricesHint')}</p>
      <textarea
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        spellCheck={false}
        rows={4}
        placeholder={'deepseek-chat: 0.27/1.10'}
        className="w-full resize-y border border-border bg-surface-2/60 px-3 py-2 font-mono text-xs leading-relaxed text-text-primary outline-none placeholder:text-text-disabled focus:border-primary"
      />
      <Button size="sm" className="self-end" onClick={() => void save()}>
        <Icon name="check" size={13} />
        {t('common.save')}
      </Button>
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
      pipeline_auto_collect_minutes: String(cfg.pipeline_auto_collect_minutes ?? 30),
      pipeline_publish_target: cfg.pipeline_publish_target ?? 'noop',
      pipeline_auto_publish: String(cfg.pipeline_auto_publish ?? false),
      pipeline_auto_publish_daily_limit: String(cfg.pipeline_auto_publish_daily_limit ?? 5),
      pipeline_auto_promote_daily: String(cfg.pipeline_auto_promote_daily ?? 3),
      pipeline_auto_publish_tick_minutes: String(cfg.pipeline_auto_publish_tick_minutes ?? 5),
      pipeline_sources: (cfg.pipeline_sources ?? ['hot']).join(', '),
      pipeline_subtitle_font_size: String(cfg.pipeline_subtitle_font_size ?? 24),
      pipeline_subtitle_outline: String(cfg.pipeline_subtitle_outline ?? 1),
      pipeline_subtitle_bold: String(cfg.pipeline_subtitle_bold ?? false),
      pipeline_subtitle_alignment: String(cfg.pipeline_subtitle_alignment ?? 2),
      pipeline_subtitle_fade_ms: String(cfg.pipeline_subtitle_fade_ms ?? 300),
      pipeline_subtitle_margin_bottom: String(cfg.pipeline_subtitle_margin_bottom ?? 72),
      pipeline_subtitle_lang: cfg.pipeline_subtitle_lang ?? 'zh-CN',
      pipeline_translate_source_lang: cfg.pipeline_translate_source_lang ?? 'en-US',
      pipeline_tts_text_source: cfg.pipeline_tts_text_source ?? 'script',
      pipeline_reddit_client_id: cfg.pipeline_reddit_client_id ?? '',
      pipeline_reddit_client_secret: '',
      pipeline_reddit_cookie: '',
      pipeline_reddit_cookies_browser: cfg.pipeline_reddit_cookies_browser ?? '',
    })
  }, [cfg])

  function set<K extends keyof typeof form>(key: K, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }))
    setDirty(true)
  }

  // v0.11.6 源池勾选：pipeline_sources 字符串 ↔ 目录源/自定义源拆分
  const enabledSources = useMemo(
    () =>
      (form.pipeline_sources ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    [form.pipeline_sources],
  )
  const customOnly = useMemo(
    () => enabledSources.filter((s) => !SOURCE_CATALOG_NAMES.has(s)),
    [enabledSources],
  )
  function toggleSource(name: string) {
    const next = enabledSources.includes(name)
      ? enabledSources.filter((s) => s !== name)
      : [...enabledSources, name]
    set('pipeline_sources', next.join(', '))
  }
  function setCustom(v: string) {
    const custom = v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    set(
      'pipeline_sources',
      [...enabledSources.filter((s) => SOURCE_CATALOG_NAMES.has(s)), ...custom].join(', '),
    )
  }

  async function save() {
    const overrides: Record<string, unknown> = {
      data_dir: form.data_dir?.trim(),
      output_dir: form.output_dir?.trim(),
      log_dir: form.log_dir?.trim(),
      assets_root: form.assets_root?.trim() || null,
      pipeline_min_score: Number(form.pipeline_min_score),
      pipeline_collect_limit: Number(form.pipeline_collect_limit),
      pipeline_auto_collect_minutes: Number(form.pipeline_auto_collect_minutes) || 0,
      pipeline_publish_target: form.pipeline_publish_target,
      pipeline_auto_publish: form.pipeline_auto_publish === 'true',
      pipeline_auto_publish_daily_limit: Number(form.pipeline_auto_publish_daily_limit) || 5,
      pipeline_auto_promote_daily: Number(form.pipeline_auto_promote_daily) || 3,
      pipeline_auto_publish_tick_minutes: Number(form.pipeline_auto_publish_tick_minutes) || 5,
      pipeline_sources: form.pipeline_sources
        ?.split(',')
        .map((s) => s.trim())
        .filter(Boolean) || ['hot'],
      pipeline_subtitle_font_size: Number(form.pipeline_subtitle_font_size) || 24,
      pipeline_subtitle_outline: Number(form.pipeline_subtitle_outline) || 1,
      pipeline_subtitle_bold: form.pipeline_subtitle_bold === 'true',
      pipeline_subtitle_alignment: Number(form.pipeline_subtitle_alignment) || 2,
      pipeline_subtitle_fade_ms: Number(form.pipeline_subtitle_fade_ms) || 300,
      pipeline_subtitle_margin_bottom: Number(form.pipeline_subtitle_margin_bottom) || 72,
      pipeline_subtitle_lang: form.pipeline_subtitle_lang || 'zh-CN',
      pipeline_translate_source_lang: form.pipeline_translate_source_lang || 'en-US',
      pipeline_tts_text_source: form.pipeline_tts_text_source || 'script',
    }
    if (form.pipeline_reddit_client_id?.trim())
      overrides.pipeline_reddit_client_id = form.pipeline_reddit_client_id.trim()
    if (form.pipeline_reddit_client_secret)
      overrides.pipeline_reddit_client_secret = form.pipeline_reddit_client_secret
    if (form.pipeline_reddit_cookie)
      overrides.pipeline_reddit_cookie = form.pipeline_reddit_cookie
    if (form.pipeline_reddit_cookies_browser)
      overrides.pipeline_reddit_cookies_browser = form.pipeline_reddit_cookies_browser
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
                    <Icon name="config" size={15} />
                    {t('settings.health')}
                  </h2>
                  {/* 系统健康看板（v0.11.6）：/api/health 可视化 */}
                  <div className="mt-2">
                    <HealthDashboard />
                  </div>
                </section>

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
                {/* 功能 → 模型 总览（素材 AI 整理/翻译/评分都走 fast 池，配置点在下方） */}
                <section className={section}>
                  <div className="mb-2 flex items-center gap-2">
                    <Icon name="layers" size={15} />
                    <h2 className="text-sm font-semibold text-text-primary">{t('settings.features')}</h2>
                  </div>
                  <div className="mt-2">
                    <FeaturesMap />
                  </div>
                </section>

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

                <section className={section}>
                  <div className="mb-2 flex items-center gap-2">
                    <Icon name="config" size={15} />
                    <h2 className="text-sm font-semibold text-text-primary">{t('settings.prices')}</h2>
                  </div>
                  <ModelPrices />
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
                  <div className="mt-3">
                    <span className="text-xs font-medium text-text-primary">{t('settings.sources')}</span>
                    {/* 源池勾选（v0.11.6 情感频道）：目录常量 + 勾选 → pipeline_sources */}
                    {SOURCE_GROUPS.map((g) => {
                      const enabled = enabledSources
                      return (
                        <div key={g.id} className="mt-2">
                          <p className="text-[10px] uppercase tracking-wide text-text-disabled">
                            {t(g.labelKey)}
                          </p>
                          <div className="mt-1 flex flex-wrap gap-1.5">
                            {g.sources.map((name) => {
                              const on = enabled.includes(name)
                              return (
                                <button
                                  key={name}
                                  type="button"
                                  onClick={() => toggleSource(name)}
                                  className={`border px-2 py-0.5 text-[11px] transition-colors ${
                                    on
                                      ? 'border-primary/50 bg-primary/15 font-medium text-primary'
                                      : 'border-border text-text-secondary hover:border-primary hover:text-primary'
                                  }`}
                                >
                                  {name}
                                </button>
                              )
                            })}
                          </div>
                        </div>
                      )
                    })}
                    {/* 自定义源（目录外 subreddit，逗号分隔） */}
                    <input
                      type="text"
                      value={customOnly.join(', ')}
                      onChange={(e) => setCustom(e.target.value)}
                      placeholder={t('settings.sourcesCustomPlaceholder')}
                      className="mt-2 h-7 w-full rounded-sm border border-border bg-surface-1 px-2 text-xs text-text-primary outline-none placeholder:text-text-disabled focus:border-primary"
                    />
                    <p className="mt-1 text-xs leading-relaxed text-text-disabled">
                      {t('settings.sourcesHint')}
                    </p>
                  </div>
                  <div className="mt-3">
                    <Input
                      label={t('settings.autoCollect')}
                      type="number"
                      value={form.pipeline_auto_collect_minutes ?? '30'}
                      onChange={(e) => set('pipeline_auto_collect_minutes', e.target.value)}
                    />
                    <p className="mt-1 text-xs leading-relaxed text-text-disabled">
                      {t('settings.autoCollectHint')}
                    </p>
                  </div>
                  {/* 自动发布队列（v0.12）：总开关 + 每日产能 + 预发布转正 + tick 间隔 */}
                  <div className="mt-4 border-t border-border/60 pt-3">
                    <p className="text-xs font-medium text-text-primary">{t('settings.autoPublish')}</p>
                    <div className="mt-2 grid gap-3 sm:grid-cols-2">
                      <Select
                        label={t('settings.autoPublishEnabled')}
                        value={form.pipeline_auto_publish ?? 'false'}
                        onChange={(e) => set('pipeline_auto_publish', e.target.value)}
                        options={[
                          { value: 'true', label: t('common.yes') },
                          { value: 'false', label: t('common.no') },
                        ]}
                      />
                      <Input
                        label={t('settings.autoPublishDailyLimit')}
                        type="number"
                        min={0}
                        value={form.pipeline_auto_publish_daily_limit ?? '5'}
                        onChange={(e) => set('pipeline_auto_publish_daily_limit', e.target.value)}
                      />
                      <Input
                        label={t('settings.autoPromoteDaily')}
                        type="number"
                        min={0}
                        value={form.pipeline_auto_promote_daily ?? '3'}
                        onChange={(e) => set('pipeline_auto_promote_daily', e.target.value)}
                      />
                      <Input
                        label={t('settings.autoPublishTickMinutes')}
                        type="number"
                        min={1}
                        value={form.pipeline_auto_publish_tick_minutes ?? '5'}
                        onChange={(e) => set('pipeline_auto_publish_tick_minutes', e.target.value)}
                      />
                    </div>
                    <p className="mt-2 text-xs leading-relaxed text-text-disabled">
                      {t('settings.autoPublishHint')}
                    </p>
                  </div>
                </section>

                <section className={section}>
                  <h2 className={heading}>
                    <Icon name="layers" size={15} />
                    {t('settings.subtitleStyle')}
                  </h2>
                  <p className={sub}>{t('settings.subtitleStyleHint')}</p>
                  <div className="mt-2 grid gap-3 sm:grid-cols-4">
                    <Input
                      label={t('settings.subtitleFontSize')}
                      type="number"
                      value={form.pipeline_subtitle_font_size ?? '26'}
                      onChange={(e) => set('pipeline_subtitle_font_size', e.target.value)}
                    />
                    <Input
                      label={t('settings.subtitleOutline')}
                      type="number"
                      value={form.pipeline_subtitle_outline ?? '2'}
                      onChange={(e) => set('pipeline_subtitle_outline', e.target.value)}
                    />
                    <Select
                      label={t('settings.subtitleBold')}
                      value={form.pipeline_subtitle_bold ?? 'true'}
                      onChange={(e) => set('pipeline_subtitle_bold', e.target.value)}
                      options={[
                        { value: 'true', label: t('common.yes') },
                        { value: 'false', label: t('common.no') },
                      ]}
                    />
                    <Select
                      label={t('settings.subtitleAlign')}
                      value={form.pipeline_subtitle_alignment ?? '2'}
                      onChange={(e) => set('pipeline_subtitle_alignment', e.target.value)}
                      options={[
                        { value: '1', label: t('settings.subtitleAlignBottom') },
                        { value: '2', label: t('settings.subtitleAlignMiddle') },
                        { value: '3', label: t('settings.subtitleAlignTop') },
                      ]}
                    />
                    <Input
                      label={t('settings.subtitleFadeMs')}
                      type="number"
                      value={form.pipeline_subtitle_fade_ms ?? '300'}
                      onChange={(e) => set('pipeline_subtitle_fade_ms', e.target.value)}
                    />
                    <Input
                      label={t('settings.subtitleMarginBottom')}
                      type="number"
                      value={form.pipeline_subtitle_margin_bottom ?? '72'}
                      onChange={(e) => set('pipeline_subtitle_margin_bottom', e.target.value)}
                    />
                  </div>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <Select
                      label={t('settings.subtitleTargetLang')}
                      value={form.pipeline_subtitle_lang ?? 'zh-CN'}
                      onChange={(e) => set('pipeline_subtitle_lang', e.target.value)}
                      options={LANG_OPTIONS}
                    />
                    <Select
                      label={t('settings.translateSourceLang')}
                      value={form.pipeline_translate_source_lang ?? 'en-US'}
                      onChange={(e) => set('pipeline_translate_source_lang', e.target.value)}
                      options={LANG_OPTIONS}
                    />
                    <Select
                      label={t('settings.ttsTextSource')}
                      value={form.pipeline_tts_text_source ?? 'script'}
                      onChange={(e) => set('pipeline_tts_text_source', e.target.value)}
                      options={[
                        { value: 'script', label: t('settings.ttsTextSourceScript') },
                        { value: 'subtitle', label: t('settings.ttsTextSourceSubtitle') },
                      ]}
                    />
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-text-disabled">
                    {t('settings.langHint')}
                  </p>
                </section>

                {/* Reddit 采集（v0.8.1 起 OAuth 与 Cookie 双通道，合并为一个配置区） */}
                <section className={section}>
                  <h2 className={heading}>
                    <Icon name="downloads" size={15} />
                    {t('settings.redditCollect')}
                  </h2>
                  <p className={sub}>{t('settings.redditCollectHint')}</p>
                  {/* OAuth 凭证（官方认证通道） */}
                  <div className="mt-2">
                    <p className="text-xs font-medium text-text-primary">{t('settings.redditOAuth')}</p>
                    <div className="mt-2 grid gap-3 sm:grid-cols-2">
                      <Input
                        label={t('settings.redditClientId')}
                        value={form.pipeline_reddit_client_id ?? ''}
                        onChange={(e) => set('pipeline_reddit_client_id', e.target.value)}
                        placeholder={cfg?.pipeline_reddit_client_id ? '••••••••' : ''}
                      />
                      <Input
                        label={t('settings.redditClientSecret')}
                        type="password"
                        value={form.pipeline_reddit_client_secret ?? ''}
                        onChange={(e) => set('pipeline_reddit_client_secret', e.target.value)}
                        placeholder={cfg?.pipeline_reddit_client_secret_set ? '••••••••' : ''}
                      />
                    </div>
                  </div>
                  {/* Cookie 通道（登录解锁） */}
                  <div className="mt-4 border-t border-border/60 pt-3">
                    <p className="text-xs font-medium text-text-primary">{t('settings.redditCookie')}</p>
                    <div className="mt-2 grid gap-3 sm:grid-cols-2">
                      <Input
                        label={t('settings.redditCookieRaw')}
                        value={form.pipeline_reddit_cookie ?? ''}
                        onChange={(e) => set('pipeline_reddit_cookie', e.target.value)}
                        placeholder={t('settings.redditCookiePlaceholder')}
                      />
                      <Input
                        label={t('settings.redditCookieBrowser')}
                        value={form.pipeline_reddit_cookies_browser ?? ''}
                        onChange={(e) => set('pipeline_reddit_cookies_browser', e.target.value)}
                        placeholder={t('settings.redditCookieBrowserPlaceholder')}
                      />
                    </div>
                    <RedditCookieCard />
                  </div>
                </section>

                <section className={section}>
                  <h2 className={heading}>
                    <Icon name="box" size={15} />
                    {t('settings.biliPublish')}
                  </h2>
                  <p className={sub}>{t('settings.biliPublishHint')}</p>
                  <PublishStatusCard onChanged={() => void refetch()} />
                </section>

                {/* 基础依赖（v0.8.8）：启动时检测一次 + 手动重测——运行时零探测 */}
                <section className={section}>
                  <h2 className={heading}>
                    <Icon name="config" size={15} />
                    {t('settings.depsTitle')}
                  </h2>
                  <p className={sub}>{t('settings.depsHint')}</p>
                  <DepsCard />
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
