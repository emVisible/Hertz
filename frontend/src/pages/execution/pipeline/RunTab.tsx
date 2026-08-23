/** Pipeline 运行 tab（v0.20 拆分，D-183）：采集运维卡 / 采集源状态 / 最近轮次。
 *  纯结构移动自 PipelineView（原 377-550 行段），零行为变化；零本地依赖 props {p}。 */

import { useTranslation } from 'react-i18next'

import { Badge, Button, Icon } from '../../../components/ui'
import { SectionCard } from '../../../components/execution'
import { CollectHistory } from '../CollectHistory'
import type { PipelineViewProps } from './shared'

export function RunTab({ p }: { p: PipelineViewProps }) {
  const { t } = useTranslation()
  return (
    <div className="flex min-h-full flex-col gap-4 p-4">
      {/* 运维控制卡（v0.8.2）：自动静默运行，监视 + 手动操作 */}
      <SectionCard title={t('console.collectOps')} padded={false}>
        <div className="flex flex-wrap items-center gap-3 p-3">
          <span className="flex items-center gap-2 text-sm">
            <span
              className={`inline-block h-2.5 w-2.5 rounded-full ${
                p.collectStatus?.running ? 'animate-pulse bg-primary' : 'bg-text-disabled/40'
              }`}
            />
            <span className="font-medium text-text-primary">
              {p.collectStatus?.running
                ? t('console.collectRunning')
                : t('console.collectIdle')}
            </span>
          </span>
          {/* 上次采集结果 */}
          {p.collectStatus?.last?.started_at && !p.collectStatus.running && (
            <span className="text-xs text-text-secondary">
              {t('console.collectLastAt', {
                when: new Date(p.collectStatus.last.started_at).toLocaleTimeString(),
              })}
              {' · '}
              {t('console.collected', {
                n: Number((p.collectStatus.last.summary?.collected as number) ?? 0),
              })}
              {' · '}
              {t('console.inserted', {
                n: Number((p.collectStatus.last.summary?.inserted as number) ?? 0),
              })}
            </span>
          )}
          {/* 自动采集状态 + 下次 */}
          {p.collectStatus?.auto_enabled ? (
            <Badge tone="success">
              <span title={t('console.autoCollectHint')}>
                {t('console.autoCollectOn', { n: p.collectStatus.interval_min })}
                {p.collectStatus.next_in_s != null && !p.collectStatus.running
                  ? ` · ${t('console.collectNextIn', { s: Math.ceil(p.collectStatus.next_in_s / 60) })}`
                  : ''}
              </span>
            </Badge>
          ) : (
            <Badge tone="neutral">
              <span title={t('console.autoCollectHint')}>
                {t('console.autoCollectOff')}
              </span>
            </Badge>
          )}
          <span className="flex items-center gap-1.5 text-xs">
            <Icon name="downloads" size={13} className="text-text-disabled" />
            <span className="text-text-secondary">
              {t('console.preStage.discovered')}: {p.counts.discovered ?? 0}
            </span>
          </span>
          {/* 操作：右对齐 */}
          <span className="ml-auto flex items-center gap-2">
            <Button
              size="md"
              onClick={() => void p.runStep('collect')}
              disabled={p.running}
              title={t('console.collectHint')}
            >
              <Icon name="downloads" size={14} />
              {t('console.stageCollect')}
            </Button>
            <Button
              size="md"
              variant="danger"
              onClick={() => void p.stop()}
              disabled={!p.running}
              title={t('console.collectStopHint')}
            >
              <Icon name="stop" size={14} />
              {t('console.collectStop')}
            </Button>
          </span>
        </div>

        {/* 采集进度（v0.8.2 可视化）：最近批次各源明细 */}
        {p.collectProgress.length > 0 && (
          <div className="border-t border-border/60 p-3">
            <div className="mb-1.5 flex items-center justify-between text-[10px] uppercase tracking-wide text-text-disabled">
              <span>{t('console.collectProgress')}</span>
              <span>
                {p.collectProgress.filter((s) => s.collected != null || s.error).length}/
                {p.collectProgress.length} {t('console.collectSources')}
              </span>
            </div>
            <ul className="flex flex-col gap-1">
              {p.collectProgress.map((s) => {
                const done = s.collected != null || s.error != null
                const cooling = (s.cooldown_s ?? 0) > 0
                const failed = Boolean(s.error)
                return (
                  <li key={s.channel} className="flex items-center gap-2 text-xs">
                    <span
                      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
                        failed ? 'bg-error' : done ? 'bg-success' : cooling ? 'bg-warning' : 'bg-primary/60'
                      }`}
                    />
                    <span className="min-w-0 flex-1 truncate text-text-secondary">{s.channel}</span>
                    {failed ? (
                      <span className="shrink-0 text-[10px] text-error" title={s.error}>
                        {t('console.collectFailed')}
                      </span>
                    ) : done ? (
                      <span className="shrink-0 font-mono text-[10px] text-text-disabled">
                        +{s.inserted ?? 0}
                      </span>
                    ) : cooling ? (
                      <span className="shrink-0 font-mono text-[10px] text-warning">
                        ⏳ {Math.ceil(s.cooldown_s ?? 0)}s
                      </span>
                    ) : (
                      <span className="shrink-0 animate-pulse text-[10px] text-primary">
                        {t('console.collectWorking')}
                      </span>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
        )}
      </SectionCard>

      {/* 采集源状态（参考原项目漏斗水位）；待下载队列已并入预处理（v0.8.6） */}
      <SectionCard title={t('console.sources')} padded={false} className="shrink-0">
        <ul className="max-h-40 space-y-1 overflow-y-auto p-3 text-xs">
          {p.sources.length === 0 && <p className="text-text-disabled">{t('console.noSources')}</p>}
          {p.sources.map((s) => (
            <li key={`${s.source}:${s.channel}`} className="flex items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-1.5">
                <span
                  title={t(`console.sourceHealth.${s.health}`)}
                  className={`h-2 w-2 shrink-0 rounded-full ${
                    s.health === 'healthy'
                      ? 'bg-emerald-400'
                      : s.health === 'degraded'
                        ? 'bg-warning'
                        : 'bg-error'
                  }`}
                />
                <span className="truncate">{s.source}:{s.channel}</span>
              </span>
              <span
                className="shrink-0 text-text-secondary"
                title={s.last_error ?? undefined}
              >
                ok {s.ok_count} / fail {s.fail_count}
              </span>
              {/* 单源采集（v0.5 C）：源失联/冷却后可单独重试 */}
              <button
                type="button"
                disabled={p.running}
                onClick={() => void p.runStep('collect', s.channel)}
                title={t('console.collectSourceHint')}
                className="shrink-0 border border-border px-1.5 py-0.5 text-[10px] text-text-secondary transition-colors hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Icon name="downloads" size={11} />
              </button>
            </li>
          ))}
        </ul>
      </SectionCard>

      {/* 最近采集轮次（v0.8.7）：历史时间线——采集卡可直接回看最近 N 轮结果 */}
      <SectionCard title={t('console.act.recentCollects')} padded={false} className="shrink-0">
        <CollectHistory />
      </SectionCard>
    </div>
  )
}
