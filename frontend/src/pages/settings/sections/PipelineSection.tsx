/** Settings 流水线区（v0.20 拆分）：采集与热点监控 / 源池 / 自动发布队列 /
 *  发布策略引擎 / Telegram 审核 Bot / 字幕样式与语言 / Reddit 采集 /
 *  B 站发布状态 / 基础依赖。纯结构移动自 SettingsPage，零行为变化。 */

import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { useState } from 'react'

import { api } from '../../../api'
import { modelState, modelStateTone } from '../../../core/modelStatus'
import { Badge, Button, Icon, Input, Select, useToast } from '../../../components/ui'
import { SOURCE_CATALOG_NAMES, SOURCE_GROUPS } from '../../../constants/sources'
 import { BILI_TIDS } from '../../../constants/bilibili'
import { heading, sub, type SectionProps } from './shared'
import { PublishStatusCard } from './settingsCards'
import { ChannelsCard } from './ChannelsCard'

/**
 * 并发任务族：字段名必须与后端 `factory/concurrency.DEFAULT_LIMITS` 的键
 * 一一对应（后端读 `settings.concurrency_<kind>`）。两边各写一份字面量就会漂。
 */
/** 画幅档位：与后端 producers/resolution._ALLOWED_* 保持一致。 */
const VIDEO_PRESETS = [
  { label: '720p', w: 1280, h: 720, fps: 30 },
  { label: '1080p', w: 1920, h: 1080, fps: 30 },
  { label: '1440p', w: 2560, h: 1440, fps: 30 },
  { label: '4K', w: 3840, h: 2160, fps: 30 },
  { label: '1080p60', w: 1920, h: 1080, fps: 60 },
] as const

const CONCURRENCY_KINDS = ['llm', 'image', 'tts', 'download', 'pipeline'] as const
const CONCURRENCY_DEFAULTS: Record<(typeof CONCURRENCY_KINDS)[number], number> = {
  llm: 4,
  image: 2,
  tts: 2,
  download: 3,
  pipeline: 2,
}

/** 本地模型状态卡通用件（v0.32 S4）：就绪徽章 + 后台下载 + 轮询到就绪。
 *  翻译与转写两个引擎这件事的语义完全一致（只是端点与文案），复制两份轮询
 *  循环的下场是下次改动只改到一半。 */
type ModelStatus = {
  deps: boolean
  model_ready: boolean
  model_name?: string
  xinference_on?: boolean
}

function ModelStatusCard({
  queryKey,
  statusPath,
  downloadPath,
  texts,
  actionText,
  noteText,
}: {
  queryKey: string
  statusPath: string
  downloadPath: string
  /** 引擎相关文案（拿到状态后才算，档位名要进徽章）；「还没问到 / 问失败」由公共
   *  文案承担，判定见 core/modelStatus */
  texts: (s: ModelStatus) => { noDeps: string; ready: string; missing: string }
  actionText: string
  noteText?: (s: ModelStatus) => string | null
}) {
  const { t } = useTranslation()
  const [downloading, setDownloading] = useState(false)
  const { data, isError, refetch } = useQuery({
    queryKey: [queryKey],
    queryFn: () => api.get<ModelStatus>(statusPath),
    // 保存档位后徽章要自己变绿/变琥珀：这张卡的查询不在主壳 save() 的失效范围内
    refetchInterval: 15_000,
  })

  async function startDownload() {
    setDownloading(true)
    await api.post(downloadPath)
    const deadline = Date.now() + 1_800_000 // 141MB~3GB 级下载，留足轮询窗口
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000))
      const st = await api.get<ModelStatus>(statusPath)
      if (st.model_ready) break
    }
    setDownloading(false)
    await refetch()
  }

  const state = modelState({
    loaded: !!data,
    error: isError,
    deps: data?.deps,
    ready: data?.model_ready,
  })
  // data 到位后 state 只会是 noDeps / ready / missing 三者之一（见 modelState）
  const label = !data
    ? isError
      ? t('settings.modelStatusUnavailable')
      : t('settings.modelChecking')
    : texts(data)[state as 'noDeps' | 'ready' | 'missing']

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
      <Badge tone={modelStateTone(state)}>{label}</Badge>
      {state === 'missing' && (
        <Button size="sm" variant="secondary" disabled={downloading} onClick={() => void startDownload()}>
          <Icon name="downloads" size={12} />
          {downloading ? t('settings.modelDownloading') : actionText}
        </Button>
      )}
      {state === 'unavailable' && (
        <Button size="sm" variant="secondary" onClick={() => void refetch()}>
          {t('common.retry')}
        </Button>
      )}
      {data && noteText?.(data) ? <span className="text-text-disabled">{noteText(data)}</span> : null}
    </div>
  )
}

/** 本地翻译模型状态卡（v0.22.x）：依赖/模型就绪态 + 一键下载（后台任务轮询）。 */
export function TranslateModelStatus() {
  const { t } = useTranslation()
  return (
    <ModelStatusCard
      queryKey="translate-model-status"
      statusPath="/api/pipeline/translate-model/status"
      downloadPath="/api/pipeline/translate-model/download"
      texts={() => ({
        noDeps: t('settings.translateModelNoDeps'),
        ready: t('settings.translateModelReady'),
        missing: t('settings.translateModelMissing'),
      })}
      actionText={t('settings.translateModelDownload')}
    />
  )
}

/** 本地转写模型状态卡（v0.32 S4）：档位显于徽章，切档位后这里就是重下入口。 */
export function WhisperModelStatus() {
  const { t } = useTranslation()
  return (
    <ModelStatusCard
      queryKey="whisper-model-status"
      statusPath="/api/pipeline/whisper-model/status"
      downloadPath="/api/pipeline/whisper-model/download"
      texts={(s) => ({
        noDeps: t('settings.whisperModelNoDeps'),
        ready: t('settings.whisperModelReady', { name: s.model_name ?? '' }),
        missing: t('settings.whisperModelMissing', { name: s.model_name ?? '' }),
      })}
      actionText={t('settings.whisperModelDownload')}
      noteText={(s) => (s.xinference_on ? t('settings.whisperModelViaService') : null)}
    />
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
        <Button
          size="sm"
          onClick={() => void exportCookie()}
          loading={busy}
          icon={<Icon name="downloads" size={12} />}
        >
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

          {/* 评分预过滤（v0.37 补齐）：LLM 评分前的廉价门槛。先用 reddit 分和
              点赞率把明显不行的挡掉，省下模型调用。原先只能改 .env。 */}
          <div className="mt-4 border-t border-border/60 pt-3">
            <p className="text-xs font-medium text-text-primary">{t('settings.prefilter')}</p>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <Input
                label={t('settings.prefilterMinScore')}
                type="number"
                min={0}
                value={form.pipeline_prefilter_min_reddit_score ?? '50'}
                onChange={(e) => set('pipeline_prefilter_min_reddit_score', e.target.value)}
              />
              <Input
                label={t('settings.prefilterMinRatio')}
                type="number"
                min={0}
                max={1}
                step={0.01}
                value={form.pipeline_prefilter_min_upvote_ratio ?? '0.85'}
                onChange={(e) => set('pipeline_prefilter_min_upvote_ratio', e.target.value)}
              />
            </div>
            <p className="mt-1.5 text-xs leading-relaxed text-text-disabled">
              {t('settings.prefilterHint')}
            </p>
          </div>
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
        {/* 成片画幅（v0.37）：原先 1280x720 写死在 5 个文件。其中 compose 的
            实际输出与 subtitles 的 ASS PlayResX/Y 必须一致——ASS 用 PlayRes
            定义字幕坐标系，两者漂了字号与边距会静默缩放错，不报任何错。 */}
        <div className="mt-4 border-t border-border/60 pt-3">
          <p className="text-xs font-medium text-text-primary">{t('settings.outputResolution')}</p>
          <div className="mt-2 grid gap-3 sm:grid-cols-1">
            <Select
              label={t('settings.outputResolution')}
              // 值用「宽x高@帧率」拼出来：三个字段是一个选择，一次改完。
              // 拆成三个独立输入框的话，用户会配出 1280 宽 + 2160 高这种
              // 不存在的组合，后端只能静默回落到默认。
              value={`${form.pipeline_video_width ?? '1280'}x${form.pipeline_video_height ?? '720'}@${form.pipeline_video_fps ?? '30'}`}
              onChange={(e) => {
                const [dims, fps] = e.target.value.split('@')
                const [w, hgt] = (dims ?? '1280x720').split('x')
                set('pipeline_video_width', w ?? '1280')
                set('pipeline_video_height', hgt ?? '720')
                set('pipeline_video_fps', fps ?? '30')
              }}
              options={VIDEO_PRESETS.map((p) => ({
                value: `${p.w}x${p.h}@${p.fps}`,
                label: `${p.label} · ${p.fps}fps`,
              }))}
            />
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-text-disabled">{t('settings.outputResolutionHint')}</p>
        </div>

        {/* 下载韧性（v0.37 补齐）：被 403 时的退避与熔断。这些参数原先存在且
            一直在读，但只有改 .env 才能动——而它们恰恰是「被限流了怎么办」的
            第一反应要去的地方。 */}
        <div className="mt-4 border-t border-border/60 pt-3">
          <p className="text-xs font-medium text-text-primary">{t('settings.downloadResilience')}</p>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <Input
              label={t('settings.downloadDelay')}
              type="number"
              step={0.1}
              min={0}
              value={form.pipeline_download_delay_seconds ?? '1.2'}
              onChange={(e) => set('pipeline_download_delay_seconds', e.target.value)}
            />
            <Input
              label={t('settings.coolingBase')}
              type="number"
              min={0}
              value={form.pipeline_download_cooling_base_seconds ?? '300'}
              onChange={(e) => set('pipeline_download_cooling_base_seconds', e.target.value)}
            />
            <Input
              label={t('settings.coolingMax')}
              type="number"
              min={0}
              value={form.pipeline_download_cooling_max_seconds ?? '7200'}
              onChange={(e) => set('pipeline_download_cooling_max_seconds', e.target.value)}
            />
            <Input
              label={t('settings.cdnCircuit403')}
              type="number"
              min={1}
              value={form.pipeline_cdn_circuit_403 ?? '3'}
              onChange={(e) => set('pipeline_cdn_circuit_403', e.target.value)}
            />
            <Input
              label={t('settings.cdnCircuitCooldown')}
              type="number"
              min={0}
              value={form.pipeline_cdn_circuit_cooldown ?? '600'}
              onChange={(e) => set('pipeline_cdn_circuit_cooldown', e.target.value)}
            />
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-text-disabled">
            {t('settings.downloadResilienceHint')}
          </p>
        </div>

        {/* 并发上限（v0.37）：原先写死在 factory/concurrency.py */}
        <div className="mt-4 border-t border-border/60 pt-3">
          <p className="text-xs font-medium text-text-primary">{t('settings.concurrency')}</p>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            {CONCURRENCY_KINDS.map((kind) => (
              <Input
                key={kind}
                label={t(`settings.concurrency_${kind}`)}
                type="number"
                min={1}
                value={form[`concurrency_${kind}`] ?? String(CONCURRENCY_DEFAULTS[kind])}
                onChange={(e) => set(`concurrency_${kind}`, e.target.value)}
              />
            ))}
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-text-disabled">
            {t('settings.concurrencyHint')}
          </p>
        </div>

        {/* 发布排期窗口（v0.37 补齐）：字段与读取代码一直都在，只是从不在
            allowlist 里——设置页渲染不出来，用户只能改 .env。窗口按**本地墙钟**
            解释（见 schedule.next_slot），所以这里填的是用户所在时区的钟点。 */}
        <div className="mt-4 border-t border-border/60 pt-3">
          <p className="text-xs font-medium text-text-primary">{t('settings.publishWindow')}</p>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <Input
              label={t('settings.publishWindows')}
              value={form.pipeline_publish_windows ?? '10:00-12:00,18:00-20:00'}
              onChange={(e) => set('pipeline_publish_windows', e.target.value)}
              placeholder="10:00-12:00,18:00-20:00"
            />
            <Input
              label={t('settings.publishMinInterval')}
              type="number"
              min={1}
              value={form.pipeline_publish_min_interval_min ?? '30'}
              onChange={(e) => set('pipeline_publish_min_interval_min', e.target.value)}
            />
            <Input
              label={t('settings.publishJitter')}
              type="number"
              min={0}
              value={form.pipeline_publish_jitter_min ?? '5'}
              onChange={(e) => set('pipeline_publish_jitter_min', e.target.value)}
            />
            <Select
              label={t('settings.biliDefaultTid')}
              value={String(form.pipeline_bili_default_tid ?? '201')}
              onChange={(e) => set('pipeline_bili_default_tid', e.target.value)}
              options={BILI_TIDS.map((x) => ({ value: String(x.tid), label: `${x.tid} ${x.name}` }))}
            />
            <Input
              label={t('settings.biliDtimeMinHours')}
              type="number"
              min={0}
              step={0.5}
              value={form.pipeline_bili_dtime_min_hours ?? '0'}
              onChange={(e) => set('pipeline_bili_dtime_min_hours', e.target.value)}
            />
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-text-disabled">
            {t('settings.publishWindowHint')}
          </p>
        </div>

        {/* 自动过审（v0.37 补齐）：超时未审的条目自动放行 */}
        <div className="mt-4 border-t border-border/60 pt-3">
          <p className="text-xs font-medium text-text-primary">{t('settings.autoApprove')}</p>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <Select
              label={t('settings.autoApproveEnabled')}
              value={form.pipeline_auto_approve ?? 'false'}
              onChange={(e) => set('pipeline_auto_approve', e.target.value)}
              options={[
                { value: 'true', label: t('common.yes') },
                { value: 'false', label: t('common.no') },
              ]}
            />
            <Input
              label={t('settings.autoApproveAfterHours')}
              type="number"
              min={1}
              value={form.pipeline_auto_approve_after_hours ?? '12'}
              onChange={(e) => set('pipeline_auto_approve_after_hours', e.target.value)}
            />
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-text-disabled">
            {t('settings.autoApproveHint')}
          </p>
        </div>

        {/* RSS 订阅（v0.37 补齐）：collectors/rss.py 的报错文案一直叫用户
            「请在设置页 pipeline_rss_feeds」——而设置页从来没有这个输入框。 */}
        <div className="mt-4 border-t border-border/60 pt-3">
          <p className="text-xs font-medium text-text-primary">{t('settings.rssFeeds')}</p>
          <div className="mt-2 space-y-3">
            <textarea
              value={form.pipeline_rss_feeds ?? ''}
              onChange={(e) => set('pipeline_rss_feeds', e.target.value)}
              placeholder={'名称|https://example.com/feed.xml\n名称2|https://example.org/rss'}
              className="h-24 w-full rounded-sm border border-border bg-surface-1 px-2 py-1.5 font-mono text-xs text-text-primary outline-none placeholder:text-text-disabled focus:border-primary"
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <Select
                label={t('settings.heuristicScoring')}
                value={form.pipeline_heuristic_scoring ?? 'true'}
                onChange={(e) => set('pipeline_heuristic_scoring', e.target.value)}
                options={[
                  { value: 'true', label: t('common.yes') },
                  { value: 'false', label: t('common.no') },
                ]}
              />
              <Input
                label={t('settings.aiStoryPerTick')}
                type="number"
                min={0}
                value={form.pipeline_ai_story_per_tick ?? '2'}
                onChange={(e) => set('pipeline_ai_story_per_tick', e.target.value)}
              />
            </div>
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-text-disabled">{t('settings.rssFeedsHint')}</p>
        </div>

        {/* 评分成本闸门（v0.37 补齐）：LLM 评分的熔断阈值。
            这两项的全部意义就是「用户能自己控制花多少钱」，把它们藏在 .env 里
            等于这个闸门由不得用户。 */}
        <div className="mt-4 border-t border-border/60 pt-3">
          <p className="text-xs font-medium text-text-primary">{t('settings.scoreCostGate')}</p>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <Input
              label={t('settings.scoreMaxPerRun')}
              type="number"
              min={0}
              value={form.pipeline_score_max_per_run ?? '50'}
              onChange={(e) => set('pipeline_score_max_per_run', e.target.value)}
            />
            <Input
              label={t('settings.scoreMaxPerDay')}
              type="number"
              min={0}
              value={form.pipeline_score_max_per_day ?? '100'}
              onChange={(e) => set('pipeline_score_max_per_day', e.target.value)}
            />
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-text-disabled">
            {t('settings.scoreCostGateHint')}
          </p>
        </div>

        {/* 内容分层门槛（v0.37）：v0.37 之前 content_tier 硬编码 8.0，这个字段
            接在 StrategyConfig 上却从没渲染过——于是「调高 premier 门槛」这件事
            根本无从下手。接线和 UI 必须同时做，只做一半等于假旋钮。 */}
        <div className="mt-4 border-t border-border/60 pt-3">
          <p className="text-xs font-medium text-text-primary">{t('settings.tiering')}</p>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <Input
              label={t('settings.premierScore')}
              type="number"
              min={0}
              step={0.5}
              value={form.pipeline_strategy_premier_score ?? '8'}
              onChange={(e) => set('pipeline_strategy_premier_score', e.target.value)}
            />
            <Input
              label={t('settings.schedulerTimezone')}
              value={form.scheduler_timezone ?? ''}
              onChange={(e) => set('scheduler_timezone', e.target.value)}
              placeholder="Asia/Shanghai"
            />
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-text-disabled">{t('settings.tieringHint')}</p>
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
            <Select
              label={t('settings.tgWeekly')}
              value={form.telegram_weekly ?? 'true'}
              onChange={(e) => set('telegram_weekly', e.target.value)}
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
            /** 不给 `?? '72'` 兜底：后端默认值是 64，而 72 这个数字来自一份早已
             *  没人同步的旧稿。它永远不触发（setForm 无条件写入该键），却与后端
             *  矛盾——哪天 setForm 漏了这个键，界面就会显示 72 并把它写回去。
             *  宁可空着，也好过放一个错的数字。 */
            value={form.pipeline_subtitle_margin_bottom ?? ''}
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
          {/* 旁白（v0.37 补齐）：字幕语言一直可调，旁白语言与语速却只能改 .env。
              旁白用什么语言、说多快，是内容调性的核心决定，不该藏在环境变量里。 */}
          <Select
            label={t('settings.narrationLang')}
            value={form.pipeline_narration_lang ?? 'en-US'}
            onChange={(e) => set('pipeline_narration_lang', e.target.value)}
            options={[
              { value: 'en-US', label: 'English' },
              { value: 'zh-CN', label: '中文' },
              { value: 'ja-JP', label: '日本語' },
              { value: 'ko-KR', label: '한국어' },
              { value: 'es-ES', label: 'Español' },
              { value: 'fr-FR', label: 'Français' },
              { value: 'de-DE', label: 'Deutsch' },
            ] as Array<{ value: string; label: string }>}
          />
          <Input
            label={t('settings.ttsRate')}
            value={form.pipeline_tts_rate ?? '+0%'}
            onChange={(e) => set('pipeline_tts_rate', e.target.value)}
            placeholder="+0%"
          />
          <Input
            label={t('settings.narrationMinWords')}
            type="number"
            min={0}
            value={form.pipeline_narration_min_words ?? '6'}
            onChange={(e) => set('pipeline_narration_min_words', e.target.value)}
          />
          <Input
            label={t('settings.narrationMaxWords')}
            type="number"
            min={1}
            value={form.pipeline_narration_max_words ?? '42'}
            onChange={(e) => set('pipeline_narration_max_words', e.target.value)}
          />
          <Input
            label={t('settings.narrationSilentBelow')}
            type="number"
            min={0}
            step={0.5}
            value={form.pipeline_narration_silent_below ?? '8'}
            onChange={(e) => set('pipeline_narration_silent_below', e.target.value)}
          />
          <p className="col-span-full text-[10px] leading-relaxed text-text-disabled sm:col-span-2">
            {t('settings.narrationHint')}
          </p>
          <div>
            <label className="mb-0.5 block text-[11px] font-medium text-text-secondary">
              {t('settings.hfEndpoint')}
            </label>
            <Input
              value={form.pipeline_hf_endpoint ?? ''}
              onChange={(e) => set('pipeline_hf_endpoint', e.target.value)}
              placeholder="https://huggingface.co"
            />
            <p className="mt-0.5 text-[10px] text-text-disabled">
              {t('settings.hfEndpointHint')}
            </p>
          </div>
          <Select
            label={t('settings.whisperModel')}
            value={form.pipeline_whisper_model ?? 'base'}
            onChange={(e) => set('pipeline_whisper_model', e.target.value)}
            options={
              [
                // tiny 中文实测不可用（D-200），不放进选项免得一键挑坏转写
                { value: 'base', label: 'base' },
                { value: 'small', label: 'small' },
                { value: 'medium', label: 'medium' },
                { value: 'large-v3', label: 'large-v3' },
              ] as Array<{ value: string; label: string }>
            }
          />
          <p className="mt-0.5 text-[10px] text-text-disabled">
            {t('settings.whisperModelHint')}
          </p>
          <TranslateModelStatus />
          <WhisperModelStatus />
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

      {/* 栏目管理（v0.22 栏目化内容工厂）：源池×音色×片头×包装 绑定单元 */}
      <ChannelsCard />

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

