import { Fragment, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { Card, Icon } from '../ui'

export interface StatusStepItem {
  key: string
  label: string
  status: string
  enabled?: boolean
  /** 该阶段产物文件（有则显示在节点下方） */
  files?: string[]
}

export interface StatusStepsProps {
  title: string
  items: StatusStepItem[]
  dotClass: (status: string) => string
  statusText: (status: string) => string
  /** 底部附加区域（如产物文件）：融入同一卡片 */
  bottom?: ReactNode
  /** 点击阶段节点回调（查看详情） */
  onSelect?: (key: string) => void
  /** 点击产物文件回调 */
  onOpenFile?: (file: string) => void
}

/**
 * 横向阶段状态（步骤条）：节点 + 名称 + 状态横向排列，溢出横向滚动；
 * 每个阶段节点下方显示其产物文件标识（有则有，无则无）；
 * bottom 区域（其他信息）融入卡片底部。
 * onSelect 提供时节点可点击（查看阶段详情）。
 */
export function StatusSteps({ title, items, dotClass, statusText, bottom, onSelect, onOpenFile }: StatusStepsProps) {
  const { t } = useTranslation()
  return (
    <Card padded={false} className="shrink-0">
      <div className="border-b border-border px-3 py-2">
        <h2 className="text-sm font-semibold">{title}</h2>
      </div>
      <div className="scrollbar-none overflow-x-auto px-4 py-3 pb-4">
        {items.length === 0 ? (
          <p className="text-xs text-text-disabled">—</p>
        ) : (
          <div className="flex items-start gap-1">
            {items.map((item, index) => (
              <Fragment key={item.key}>
                {index > 0 && <span className="mt-1 h-px w-8 shrink-0 bg-border" />}
                <div
                  className={`flex shrink-0 flex-col items-center gap-1 px-1 ${
                    item.enabled === false ? 'opacity-40' : ''
                  }`}
                >
                  <button
                    type="button"
                    onClick={onSelect ? () => onSelect(item.key) : undefined}
                    disabled={!onSelect}
                    title={onSelect ? t('execution.phaseDetail') : undefined}
                    className={`flex shrink-0 flex-col items-center gap-1 text-left ${
                      onSelect ? 'cursor-pointer transition-opacity hover:opacity-80' : 'cursor-default'
                    }`}
                  >
                    <span className={`h-2 w-2 shrink-0 ${dotClass(item.status)}`} />
                    <span className="whitespace-nowrap text-[10px] text-text-secondary">{item.label}</span>
                    <span className="whitespace-nowrap text-[9px] text-text-disabled">{statusText(item.status)}</span>
                  </button>
                  {/* 阶段产物文件：融合在该阶段节点下方（单行、最多 2 个 + 计数） */}
                  {item.files && item.files.length > 0 && (
                    <div className="mt-1 flex items-center gap-0.5">
                      {item.files.slice(0, 2).map((file) => (
                        <button
                          key={file}
                          type="button"
                          onClick={onOpenFile ? () => onOpenFile(file) : undefined}
                          title={file}
                          className={`flex max-w-24 items-center gap-0.5 border px-1.5 py-0.5 font-mono text-[9px] transition-colors ${
                            item.key === 'package'
                              ? 'border-primary/40 bg-primary/5 text-primary hover:border-primary hover:bg-primary/10'
                              : 'border-border text-text-secondary hover:border-primary hover:text-primary'
                          }`}
                        >
                          <Icon name="file" size={9} />
                          <span className="truncate">{file}</span>
                        </button>
                      ))}
                      {item.files.length > 2 && (
                        <span className="text-[9px] text-text-disabled">+{item.files.length - 2}</span>
                      )}
                    </div>
                  )}
                </div>
              </Fragment>
            ))}
          </div>
        )}
      </div>
      {bottom && <div className="border-t border-border px-4 py-2.5">{bottom}</div>}
    </Card>
  )
}
