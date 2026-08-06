import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { Badge, Button, Card, Icon, type IconName } from '../ui'

export interface CommandDeckProps {
  title: string
  icon: IconName
  running: boolean
  onRun: () => void
  onStop: () => void
  runDisabled: boolean
  runLabel?: string
  stopLabel?: string
  controls: ReactNode
}

/**
 * 执行控制台骨架（Studio/Pipeline 共用）：
 * 标题行（图标 + 标题 + 运行/空闲徽章）→ 参数区 → 主操作按钮。
 */
export function CommandDeck({
  title,
  icon,
  running,
  onRun,
  onStop,
  runDisabled,
  runLabel,
  stopLabel,
  controls,
}: CommandDeckProps) {
  const { t } = useTranslation()
  return (
    <Card padded={false} className="shrink-0">
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Icon name={icon} size={15} className="text-text-secondary" />
          {title}
        </h2>
        {running ? (
          <Badge tone="primary">
            <span className="inline-block h-1.5 w-1.5 animate-pulse bg-primary" />
            {t('execution.running')}
          </Badge>
        ) : (
          <Badge tone="neutral">{t('execution.idle')}</Badge>
        )}
      </div>
      <div className="flex flex-col gap-4 p-4 lg:flex-row lg:items-center">
        <div className="min-w-0 flex-1">{controls}</div>
        <div className="flex shrink-0 items-center">
          {running ? (
            <Button variant="danger" onClick={onStop} className="h-10 min-w-40">
              <Icon name="stop" size={15} />
              {stopLabel ?? t('execution.stop')}
            </Button>
          ) : (
            <Button onClick={onRun} disabled={runDisabled} className="h-10 min-w-40">
              <Icon name="play" size={15} />
              {runLabel ?? t('execution.run')}
            </Button>
          )}
        </div>
      </div>
    </Card>
  )
}
