/** Settings 流水线区（v0.20 拆分）：采集与热点监控 / 源池 / 自动发布队列 /
 *  发布策略引擎 / Telegram 审核 Bot / 字幕样式与语言 / Reddit 采集 /
 *  B 站发布状态 / 基础依赖。纯结构移动自 SettingsPage，零行为变化。 */

import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { useState } from 'react'

import { api } from '../../../api'
import { Badge, Button, Icon, Input, Select, useToast } from '../../../components/ui'
import { SOURCE_CATALOG_NAMES, SOURCE_GROUPS } from '../../../constants/sources'
import { heading, sub, type SectionProps } from './shared'
import { PublishStatusCard } from './settingsCards'

/** Reddit Cookie 状态卡（v0.8.1）：存在性/年龄 + 一键浏览器导出（v0.11.7 可选浏览器 + 通道验证）。 */
const COOKIE_BROWSERS = [
  { value: '', label: 'auto' },
  { value: 'chrome', label: 'Chrome' },
  { value: 'safari', label: 'Safari' },
  { value: 'edge', label: 'Edge' },
  { value: 'firefox', label: 'Firefox' },
]

export function RedditCookieCard() {
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

import { DepsCard } from './settingsCards'

interface PipelineSectionCfg {
  pipeline_reddit_client_id?: string
  pipeline_reddit_client_secret_set?: boolean
}

export function PipelineSection({
  form,
  set,
  save,
  dirty,
  cfg,
  refetchConfig,
}: SectionProps & {
  cfg?: PipelineSectionCfg
  refetchConfig: () => void
}) {
  const { t } = useTranslation()
  // 源池勾选（v0.11.6 情感频道）：目录常量 + 勾选 → pipeline_sources
  const enabledSources = (form.pipeline_sources ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const customOnly = enabledSources.filter((s) => !SOURCE_CATALOG_NAMES.has(s))

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

  return (
    <>
      <section className="border border-border bg-surface-1/60 p-4">
        <h2 className={heading}>
          <Icon name="config" size={15} />
          {t('settings.pipeline')}
        </h2>
        {/* v0.13.1 分组重排：采集与入库｜自动发布队列｜发布策略——
            每组统一 border-t + 组标题，替代此前平铺混排 */}
        <div className="mt-4 border-t border-border/60 pt-3">
          <p className="text-xs font-medium text-text-primary">{t('settings.groupCollect')}</p>
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
            <Input
              label={t('settings.autoCollect')}
              type="number"
              value={form.pipeline_auto_collect_minutes ?? '30'}
              onChange={(e) => set('pipeline_auto_collect_minutes', e.target.value)}
            />
          </div>
          <p className="mt-1 text-xs leading-relaxed text-text-disabled">
            {t('settings.autoCollectHint')}
          </p>
          {/* 热点监控（v0.16 TrendRadar 精华）：rising 高频 + 三段词法预筛 */}
          <div className="mt-4 rounded-md border border-border/60 p-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Select
                label={t('settings.watchEnabled')}
                value={form.pipeline_watch_enabled ?? 'false'}
                onChange={(e) => set('pipeline_watch_enabled', e.target.value)}
                options={[
                  { value: 'true', label: t('common.yes') },
                  { value: 'false', label: t('common.no') },
                ]}
              />
              <Input
                label={t('settings.watchSubreddits')}
                value={form.pipeline_watch_subreddits ?? ''}
                onChange={(e) => set('pipeline_watch_subreddits', e.target.value)}
                placeholder="aww, Damnthatsinteresting"
              />
              <Select
                label={t('settings.watchSort')}
                value={form.pipeline_watch_sort ?? 'rising'}
                onChange={(e) => set('pipeline_watch_sort', e.target.value)}
                options={['rising', 'hot', 'new', 'top'].map((s) => ({ value: s, label: s }))}
              />
              <Input
                label={t('settings.watchMinutes')}
                type="number"
                min={5}
                value={form.pipeline_watch_minutes ?? '15'}
                onChange={(e) => set('pipeline_watch_minutes', e.target.value)}
              />
              <Input
                label={t('settings.watchAny')}
                value={form.pipeline_watch_keywords_any ?? ''}
                onChange={(e) => set('pipeline_watch_keywords_any', e.target.value)}
                placeholder="cat dog amazing"
              />
              <Input
                label={t('settings.watchAll')}
                value={form.pipeline_watch_keywords_all ?? ''}
                onChange={(e) => set('pipeline_watch_keywords_all', e.target.value)}
              />
              <Input
                label={t('settings.watchExclude')}
                value={form.pipeline_watch_exclude ?? ''}
                onChange={(e) => set('pipeline_watch_exclude', e.target.value)}
                placeholder="politics nsfw"
              />
              <Input
                label={t('settings.watchMinScore')}
                type="number"
                min={0}
                value={form.pipeline_watch_min_score ?? '0'}
                onChange={(e) => set('pipeline_watch_min_score', e.target.value)}
              />
            </div>
            <p className="mt-2 text-xs leading-relaxed text-text-disabled">
              {t('settings.watchHint')}
            </p>
          </div>
        </div>
        <div className="mt-4 border-t border-border/60 pt-3">
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
        {/* 自动发布队列（v0.12）：总开关 + 每日产能 + 预发布转正 + tick 间隔 + 发布目标 */}
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
            <Select
              label={t('settings.publishTarget')}
              value={form.pipeline_publish_target ?? 'noop'}
              onChange={(e) => set('pipeline_publish_target', e.target.value)}
              options={[
                { value: 'noop', label: 'noop' },
                { value: 'bilibili', label: 'Bilibili' },
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
        {/* 发布策略引擎（v0.13）：健康度动态配额 + 内容分层 + 槽位约束。
            v0.13.1：全部阈值开放可调（AXIOM 可维护性）——基础 2 项平铺，
            高级 6 项折叠渐进披露 */}
        <div className="mt-4 border-t border-border/60 pt-3">
          <p className="text-xs font-medium text-text-primary">{t('settings.strategy')}</p>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <Select
              label={t('settings.strategyDryRun')}
              value={form.pipeline_strategy_dry_run ?? 'false'}
              onChange={(e) => set('pipeline_strategy_dry_run', e.target.value)}
              options={[
                { value: 'true', label: t('common.yes') },
                { value: 'false', label: t('common.no') },
              ]}
            />
            <Select
              label={t('settings.strategyEnabled')}
              value={form.pipeline_strategy_enabled ?? 'false'}
              onChange={(e) => set('pipeline_strategy_enabled', e.target.value)}
              options={[
                { value: 'true', label: t('common.yes') },
                { value: 'false', label: t('common.no') },
              ]}
            />
            <Input
              label={t('settings.strategyBaseDaily')}
              type="number"
              min={1}
              value={form.pipeline_strategy_base_daily ?? '2'}
              onChange={(e) => set('pipeline_strategy_base_daily', e.target.value)}
            />
          </div>
          <p className="mt-2 text-xs leading-relaxed text-text-disabled">
            {t('settings.strategyHint')}
          </p>
          <details className="mt-2">
            <summary className="cursor-pointer select-none text-[11px] text-text-secondary hover:text-text-primary">
              {t('settings.strategyAdvanced')}
            </summary>
            <div className="mt-2 grid gap-3 sm:grid-cols-3">
              <Input
                label={t('settings.strategyWarmupFloor')}
                type="number"
                min={1}
                value={form.pipeline_strategy_warmup_floor ?? '30'}
                onChange={(e) => set('pipeline_strategy_warmup_floor', e.target.value)}
              />
              <Input
                label={t('settings.strategyWarmupStep')}
                type="number"
                min={1}
                value={form.pipeline_strategy_warmup_step ?? '10'}
                onChange={(e) => set('pipeline_strategy_warmup_step', e.target.value)}
              />
              <Input
                label={t('settings.strategyDropRatio')}
                type="number"
                step="0.05"
                min={0}
                max={1}
                value={form.pipeline_strategy_drop_ratio ?? '0.5'}
                onChange={(e) => set('pipeline_strategy_drop_ratio', e.target.value)}
              />
              <Input
                label={t('settings.strategyCooldownViews')}
                type="number"
                min={0}
                value={form.pipeline_strategy_cooldown_floor_views ?? '10'}
                onChange={(e) =>
                  set('pipeline_strategy_cooldown_floor_views', e.target.value)
                }
              />
              <Input
                label={t('settings.strategyCooldownDays')}
                type="number"
                min={1}
                value={form.pipeline_strategy_cooldown_streak_days ?? '2'}
                onChange={(e) =>
                  set('pipeline_strategy_cooldown_streak_days', e.target.value)
                }
              />
              <Input
                label={t('settings.strategySameTidGap')}
                type="number"
                min={0}
                value={form.pipeline_strategy_min_same_tid_gap_h ?? '6'}
                onChange={(e) => set('pipeline_strategy_min_same_tid_gap_h', e.target.value)}
              />
            </div>
          </details>
        </div>
        {/* Telegram 审核 Bot（v0.18）：移动端过审 + 告警通道 */}
        <div className="mt-4 border-t border-border/60 pt-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Select
              label={t('settings.tgEnabled')}
              value={form.telegram_enabled ?? 'false'}
              onChange={(e) => set('telegram_enabled', e.target.value)}
              options={[
                { value: 'true', label: t('common.yes') },
                { value: 'false', label: t('common.no') },
              ]}
            />
            <Input
              label={t('settings.tgMinutes')}
              type="number"
              min={1}
              value={form.telegram_minutes ?? '1'}
              onChange={(e) => set('telegram_minutes', e.target.value)}
            />
            <Input
              label={t('settings.tgToken')}
              type="password"
              value={form.telegram_bot_token ?? ''}
              onChange={(e) => set('telegram_bot_token', e.target.value)}
            />
            <Input
              label={t('settings.tgChatId')}
              value={form.telegram_chat_id ?? ''}
              onChange={(e) => set('telegram_chat_id', e.target.value)}
            />
          </div>
          <p className="mt-2 text-xs leading-relaxed text-text-disabled">{t('settings.tgHint')}</p>
        </div>
      </section>

      <section className="border border-border bg-surface-1/60 p-4">
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
            options={
              [
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
              ] as Array<{ value: string; label: string }>
            }
          />
          <Select
            label={t('settings.translateSourceLang')}
            value={form.pipeline_translate_source_lang ?? 'en-US'}
            onChange={(e) => set('pipeline_translate_source_lang', e.target.value)}
            options={
              [
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
              ] as Array<{ value: string; label: string }>
            }
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
      <section className="border border-border bg-surface-1/60 p-4">
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

      <section className="border border-border bg-surface-1/60 p-4">
        <h2 className={heading}>
          <Icon name="box" size={15} />
          {t('settings.biliPublish')}
        </h2>
        <p className={sub}>{t('settings.biliPublishHint')}</p>
        <PublishStatusCard onChanged={() => void refetchConfig()} />
      </section>

      {/* 基础依赖（v0.8.8）：启动时检测一次 + 手动重测——运行时零探测 */}
      <section className="border border-border bg-surface-1/60 p-4">
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
  )
}

