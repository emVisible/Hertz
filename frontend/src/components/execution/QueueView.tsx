import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { pipelineApi } from '../../api'
import type { ContentTier, PipelineItem, PublishQueueView } from '../../api/pipeline'
import { Badge, Card, EmptyState, Icon } from '../ui'
import { QueryErrorState } from '../ui/QueryErrorState'

const TIER_BADGE: Record<ContentTier, { tone: 'primary' | 'neutral' | 'warning'; key: string }> = {
  premier: { tone: 'primary', key: 'queue.tier.premier' },
  regular: { tone: 'neutral', key: 'queue.tier.regular' },
  filler: { tone: 'warning', key: 'queue.tier.filler' },
}

function TierBadge({ tier }: { tier: string | undefined }) {
  const { t } = useTranslation()
  if (!tier || !(tier in TIER_BADGE)) return null
  const spec = TIER_BADGE[tier as ContentTier]
  return (
    <span title={t('queue.tierHint')} className="shrink-0">
      <Badge tone={spec.tone}>{t(spec.key)}</Badge>
    </span>
  )
}

function QueueRow({
  item,
  onAction,
  busy,
  actionLabel,
  actionIcon,
}: {
  item: PipelineItem
  onAction: (id: string) => void
  busy: boolean
  actionLabel: string
  actionIcon: 'play' | 'rewind'
}) {
  const { t } = useTranslation()
  return (
    <li className="flex items-center gap-3 border-b border-border/50 py-2 last:border-0">
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 truncate text-[13px] text-text-primary">
          <span className="min-w-0 flex-1 truncate">{item.title}</span>
          {/* 内容分层（v0.13）：策略选条目的可见痕迹 */}
          <TierBadge tier={item.tier} />
        </p>
        <p className="mt-0.5 flex items-center gap-2 text-[11px] text-text-disabled">
          <span>#{item.seq ?? '—'}</span>
          <span className="truncate">
            {item.scheduled_at
              ? `${t('queue.scheduledAt')} ${new Date(item.scheduled_at).toLocaleString()}`
              : t('queue.noSchedule')}
          </span>
        </p>
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={() => onAction(item.id)}
        className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-text-secondary transition-colors hover:bg-surface-2 disabled:opacity-50"
      >
        <Icon name={actionIcon} size={12} />
        {actionLabel}
      </button>
    </li>
  )
}

/** 发布队列视图（v0.12 融合）：ready/holding + 今日产能 + 账号状态卡（v0.13 策略），嵌入流水线「发布」tab。 */

const PHASE_TONE: Record<string, { tone: 'primary' | 'success' | 'warning' | 'error'; key: string }> = {
  warmup: { tone: 'primary', key: 'queue.phase.warmup' },
  normal: { tone: 'success', key: 'queue.phase.normal' },
  caution: { tone: 'warning', key: 'queue.phase.caution' },
  cooldown: { tone: 'error', key: 'queue.phase.cooldown' },
}

function AccountCard({ account }: { account: NonNullable<PublishQueueView['account']> }) {
  const { t } = useTranslation()
  const phase = PHASE_TONE[account.phase] ?? PHASE_TONE.normal
  const maxViews = Math.max(1, ...account.days.map((d) => d.views_median ?? 0))
  return (
    <Card>
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
          <Icon name="eye" size={16} className="text-primary" />
          {t('queue.accountTitle')}
          <Badge tone={phase.tone}>{t(phase.key)}</Badge>
        </div>
        <span className="font-mono text-[13px] text-text-secondary">
          {t('queue.quotaUsed', { used: account.used, quota: account.quota })}
        </span>
      </div>
      {/* 近 7 日发布/播放迷你趋势 */}
      {account.days.length > 0 && (
        <div className="mt-3 flex items-end gap-1">
          {account.days.map((d) => (
            <div
              key={d.date}
              title={`${d.date} · ${t('queue.uploadsN', { n: d.uploads })} · ${d.views_median ?? '—'}`}
              className="flex min-w-5 flex-1 flex-col items-center gap-0.5"
            >
              <span className="text-[9px] text-text-disabled">{d.uploads}</span>
              <div
                className={`w-full rounded-t-sm ${d.views_median != null && d.views_median < 10 ? 'bg-error/60' : 'bg-primary/50'}`}
                style={{ height: `${Math.max(3, Math.round(((d.views_median ?? 0) / maxViews) * 28))}px` }}
              />
            </div>
          ))}
        </div>
      )}
      {/* 判定证据（策略解释——全自动但可读） */}
      {account.reasons.length > 0 && (
        <ul className="mt-2 space-y-1">
          {account.reasons.map((r) => (
            <li key={r} className="text-[11px] leading-relaxed text-text-secondary">· {r}</li>
          ))}
        </ul>
      )}
    </Card>
  )
}

export function QueueView() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data, isLoading, error } = useQuery({
    queryKey: ['publish-queue'],
    queryFn: pipelineApi.queueView,
    refetchInterval: 30_000,
  })

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['publish-queue'] })
    qc.invalidateQueries({ queryKey: ['pipeline-items'] })
  }

  const enqueue = useMutation({
    mutationFn: ({ id, phase }: { id: string; phase: 'ready' | '' }) =>
      pipelineApi.enqueue(id, phase),
    onSuccess: invalidate,
  })

  const ready = data?.ready ?? []
  const holding = data?.holding ?? []
  const today = data?.today
  const pct = today && today.daily_limit > 0
    ? Math.min(100, Math.round((today.auto_published / today.daily_limit) * 100))
    : 0

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {/* 今日产能 */}
      <Card>
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
            <Icon name="clock" size={16} className="text-primary" />
            {t('queue.todayCapacity')}
            {today?.auto_enabled ? (
              <Badge tone="success">{t('queue.autoOn')}</Badge>
            ) : (
              <Badge tone="warning">{t('queue.autoOff')}</Badge>
            )}
          </div>
          <span className="font-mono text-[13px] text-text-secondary">
            {today ? `${today.auto_published} / ${today.daily_limit}` : '—'}
          </span>
        </div>
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-surface-2">
          <div
            className={`h-full transition-all ${pct >= 100 ? 'bg-error/70' : 'bg-primary'}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="mt-2 text-[11px] text-text-disabled">{t('queue.capacityHint')}</p>
      </Card>

      {/* 账号状态（v0.13 策略开启时展示；关闭为 null 隐藏） */}
      {data?.account && <AccountCard account={data.account} />}

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-2">
        {/* 发布队列 */}
        <Card className="flex min-h-0 flex-col">
          <h3 className="mb-2 flex items-center gap-2 text-sm font-medium text-text-primary">
            <Icon name="play" size={14} className="text-emerald-400" />
            {t('queue.ready')}
            <span className="ml-auto font-mono text-[11px] text-text-disabled">{ready.length}</span>
          </h3>
          {error ? (
            <QueryErrorState message={error instanceof Error ? error.message : String(error)} />
          ) : isLoading ? (
            <p className="py-6 text-center text-[12px] text-text-disabled">{t('common.loading')}</p>
          ) : ready.length === 0 ? (
            <EmptyState
              icon="clock"
              title={t('queue.emptyReadyTitle')}
              description={t('queue.emptyReadyDesc')}
            />
          ) : (
            <ul className="min-h-0 flex-1 overflow-y-auto">
              {ready.map((item) => (
                <QueueRow
                  key={item.id}
                  item={item}
                  busy={enqueue.isPending}
                  actionIcon="rewind"
                  actionLabel={t('queue.dequeue')}
                  onAction={(id) => enqueue.mutate({ id, phase: '' })}
                />
              ))}
            </ul>
          )}
        </Card>

        {/* 预发布队列 */}
        <Card className="flex min-h-0 flex-col">
          <h3 className="mb-2 flex items-center gap-2 text-sm font-medium text-text-primary">
            <Icon name="library" size={14} className="text-primary" />
            {t('queue.holding')}
            <span className="ml-auto font-mono text-[11px] text-text-disabled">
              {holding.length}
            </span>
          </h3>
          {error ? (
            <QueryErrorState message={error instanceof Error ? error.message : String(error)} />
          ) : isLoading ? (
            <p className="py-6 text-center text-[12px] text-text-disabled">{t('common.loading')}</p>
          ) : holding.length === 0 ? (
            <EmptyState
              icon="library"
              title={t('queue.emptyHoldingTitle')}
              description={t('queue.emptyHoldingDesc')}
            />
          ) : (
            <ul className="min-h-0 flex-1 overflow-y-auto">
              {holding.map((item) => (
                <QueueRow
                  key={item.id}
                  item={item}
                  busy={enqueue.isPending}
                  actionIcon="play"
                  actionLabel={t('queue.toReady')}
                  onAction={(id) => enqueue.mutate({ id, phase: 'ready' })}
                />
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  )
}