/** Settings 流水线区随迁卡片（v0.20 拆分）：B 站发布状态 / 基础依赖 /
 *  Reddit Cookie 状态。纯结构移动自 SettingsPage，零行为变化。 */

import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { api, pipelineApi } from '../../../api'
import { Badge, Button, Icon, useToast } from '../../../components/ui'

/** B 站发布就绪状态（v0.3.8）：目标 + cookie 检查 + 登录引导。 */
export function PublishStatusCard({ onChanged }: { onChanged: () => void }) {
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
        {/* v0.38：熔断与失败分布。
            重试/熔断做出来之后状态存进了 resource_cooldown，但此前**没有任何出口**
            ——用户看到「发布失败」，界面只说「失败」，既不知道目标是不是正被冻结，
            也看不出原因分布。这两行就是那口黑箱。 */}
        {data.target_throttled && (
          <span className="flex items-center gap-1.5 text-warning">
            <span className="h-2 w-2 rounded-full bg-warning" />
            {t('settings.publishThrottled', {
              s: Math.round(data.cooldowns_s[data.target] ?? 0),
              n: data.max_attempts,
            })}
          </span>
        )}
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
      {/* 近 7 天发布失败的原因分布。这是「为什么发不出去」的唯一答案来源：
          cookie 过期（blocked）、被限流（rate_limit）、格式问题… 此前一律落进
          publish 一个桶，看起来全都一样。 */}
      {(() => {
        const entries = Object.entries(data.failures_7d_by_class)
          .filter(([, n]) => n > 0)
          .sort((a, b) => b[1] - a[1])
        if (entries.length === 0) return null
        return (
          <p className="text-xs leading-relaxed text-text-secondary">
            {t('settings.publishFailures7d')}
            {entries.map(([cls, n]) => (
              <span key={cls} className="ml-1.5 inline-flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-error" />
                <span className="font-mono">
                  {t(`errors.class.${cls}`, { defaultValue: cls })}
                </span>
                <span className="font-mono text-text-disabled">×{n}</span>
              </span>
            ))}
          </p>
        )
      })()}
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

/** 基础依赖卡（v0.8.8 随迁）：状态徽章 + 缺失安装指引 + libass 降级警示 + 手动重测。 */
export function DepsCard() {
  const { t } = useTranslation()
  const toast = useToast()
  const { data, refetch, isFetching } = useQuery({
    queryKey: ['deps-status'],
    queryFn: () => api.get<Record<string, Record<string, unknown>>>('/api/deps'),
  })

  async function recheck() {
    try {
      await api.post('/api/deps/check')
      toast(t('settings.depsChecked'), 'success')
      await refetch()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  // v0.8.9：安装指引由后端检测结果提供（install_hint，单一真相源）
  // v0.22.x 能力矩阵：label 映射 + pending 琥珀态（待下载/未知，非错误）
  const LABELS: Record<string, string> = {
    ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', biliup: 'biliup',
    'yt-dlp': 'yt-dlp', 'edge-tts': 'edge-tts', font: '字幕字体',
    local_mt: '本地翻译', whisper_model: 'Whisper 模型',
    llm: 'LLM', telegram: 'Telegram', reddit_auth: 'Reddit 凭证',
  }
  const rows = [
    'ffmpeg', 'ffprobe', 'biliup', 'yt-dlp', 'edge-tts', 'font',
    'local_mt', 'whisper_model', 'llm', 'telegram', 'reddit_auth',
  ]
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
              <span className={`h-1.5 w-1.5 rounded-full ${
                ok ? 'bg-success' : d.status === 'pending' || d.status === 'off' ? 'bg-warning' : 'bg-error'
              }`} />
              {LABELS[key] ?? key}
            </span>
          )
        })}
        <span className="ml-auto font-mono text-[10px] text-text-disabled">
          {t('settings.depsCheckedAt', { t: (data?.checked_at as string | undefined)?.slice(5, 19).replace('T', ' ') ?? '—' })}
        </span>
      </div>

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
