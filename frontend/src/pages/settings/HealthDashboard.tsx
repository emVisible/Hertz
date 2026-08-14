import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'

import { api } from '../../api'
import { Badge, Button, Icon } from '../../components/ui'

/** /api/health 结构化负载（v0.11.6：设置页健康看板的数据契约）。 */
interface HealthCheck {
  status: string
  path?: string
  free_gb?: number
  total_gb?: number
  configured?: boolean
  provider?: string
  model?: string
  detail?: string
  tools?: Record<string, HealthCheck>
}

interface HealthPayload {
  status: string
  version?: string
  pid?: number
  started_at?: string
  checks: Record<string, HealthCheck>
}

const TONE: Record<string, 'success' | 'warning' | 'error' | 'neutral'> = {
  ok: 'success',
  warning: 'warning',
  error: 'error',
  degraded: 'warning',
}

/** 设置页系统健康看板（v0.11.6，ROADMAP 已知缺口清偿）：
 *  总状态 + 逐项检查（数据库/磁盘/LLM/图像/工具），30s 轮询 + 手动刷新。 */
export function HealthDashboard() {
  const { t } = useTranslation()
  const { data, refetch, isFetching } = useQuery({
    queryKey: ['health-dashboard'],
    queryFn: () => api.get<HealthPayload>('/api/health'),
    refetchInterval: 30_000,
  })

  if (!data) {
    return (
      <div className="flex items-center gap-2 py-2 text-xs text-text-disabled">
        <Icon name="refresh" size={12} className="animate-spin" />
        …
      </div>
    )
  }

  const checks = data.checks ?? {}
  const disk = checks.disk
  const llm = checks.llm
  const image = checks.image
  const tools = checks.tools?.tools ?? {}
  const pct = disk?.total_gb ? Math.round(((disk.free_gb ?? 0) / disk.total_gb) * 100) : 0

  return (
    <div className="flex flex-col gap-2">
      {/* 总状态 + 元信息 */}
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={TONE[data.status] ?? 'neutral'}>
          {t(`settings.healthStatus.${data.status}`)}
        </Badge>
        {data.version && (
          <span className="font-mono text-[10px] text-text-disabled">v{data.version}</span>
        )}
        {data.started_at && (
          <span className="font-mono text-[10px] text-text-disabled">
            {t('settings.healthStarted')} {data.started_at.slice(5, 19).replace('T', ' ')}
          </span>
        )}
        {data.pid != null && (
          <span className="font-mono text-[10px] text-text-disabled">pid {data.pid}</span>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          disabled={isFetching}
          onClick={() => void refetch()}
        >
          <Icon name="refresh" size={12} className={isFetching ? 'animate-spin' : ''} />
          {t('settings.healthRefresh')}
        </Button>
      </div>

      {/* 逐项检查 */}
      <div className="grid gap-1.5 sm:grid-cols-2">
        {/* 数据库 */}
        <div className="flex items-center gap-2 rounded-sm border border-border/60 px-2 py-1.5">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            checks.database?.status === 'ok' ? 'bg-emerald-400' : 'bg-red-400'
          }`} />
          <span className="text-xs text-text-primary">{t('settings.healthDatabase')}</span>
          <span className="ml-auto text-[10px] text-text-disabled">{checks.database?.status}</span>
        </div>
        {/* 磁盘 */}
        <div className="flex items-center gap-2 rounded-sm border border-border/60 px-2 py-1.5">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            disk?.status === 'ok' ? 'bg-emerald-400' : disk?.status === 'warning' ? 'bg-warning' : 'bg-red-400'
          }`} />
          <span className="text-xs text-text-primary">{t('settings.healthDisk')}</span>
          <span className="ml-auto font-mono text-[10px] text-text-secondary">
            {disk?.free_gb != null ? `${disk.free_gb.toFixed(1)}G / ${disk.total_gb?.toFixed(0)}G (${pct}%)` : '—'}
          </span>
        </div>
        {/* LLM */}
        <div className="flex items-center gap-2 rounded-sm border border-border/60 px-2 py-1.5">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            llm?.status === 'ok' ? 'bg-emerald-400' : llm?.status === 'warning' ? 'bg-warning' : 'bg-red-400'
          }`} />
          <span className="text-xs text-text-primary">{t('settings.healthLlm')}</span>
          <span className="ml-auto truncate text-[10px] text-text-secondary" title={llm?.model}>
            {llm?.provider ?? '—'}
            {llm?.model ? ` · ${llm.model}` : ''}
          </span>
        </div>
        {/* 图像 */}
        <div className="flex items-center gap-2 rounded-sm border border-border/60 px-2 py-1.5">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            image?.status === 'ok' ? 'bg-emerald-400' : image?.status === 'warning' ? 'bg-warning' : 'bg-red-400'
          }`} />
          <span className="text-xs text-text-primary">{t('settings.healthImage')}</span>
          <span className="ml-auto truncate text-[10px] text-text-secondary" title={image?.detail}>
            {image?.status === 'ok' ? t('settings.healthReady') : image?.detail ?? image?.status}
          </span>
        </div>
      </div>

      {/* 工具链 */}
      <div className="flex flex-wrap items-center gap-1.5">
        {Object.entries(tools).map(([name, tool]) => (
          <span
            key={name}
            title={tool.path}
            className={`inline-flex items-center gap-1 border px-1.5 py-0.5 font-mono text-[10px] ${
              tool.status === 'ok'
                ? 'border-emerald-400/30 text-text-secondary'
                : 'border-red-400/30 text-red-400'
            }`}
          >
            <span className={`h-1 w-1 rounded-full ${tool.status === 'ok' ? 'bg-emerald-400' : 'bg-red-400'}`} />
            {name}
          </span>
        ))}
      </div>
    </div>
  )
}
