/** Settings 分区共享件（v0.20 拆分）：SectionProps 契约 + 样式常量 + PathField。 */
import type React from 'react'
import { useTranslation } from 'react-i18next'

import { Button, Icon, Input } from '../../../components/ui'

export interface SectionProps {
  /** 表单草稿（主壳统一持有——保存语义全局一致，避免双真相源） */
  form: Record<string, string>
  set: (key: string, value: string) => void
  save: () => void
  dirty: boolean
  /** 系统目录选择（Electron pickDirectory；浏览器降级提示） */
  pickPath: (key: string) => void
}

export const section =
  'border border-border bg-surface-1/60 p-4'
export const heading =
  'mb-1 flex items-center gap-2 text-sm font-semibold text-text-primary'
export const sub = 'mb-3 text-xs leading-relaxed text-text-disabled'

/** 路径输入 + 系统目录选择按钮（桌面端经 Electron 呼出 Finder/资源管理器）。 */
export function PathField({
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
        <Input label={label} value={value} onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value)} />
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
