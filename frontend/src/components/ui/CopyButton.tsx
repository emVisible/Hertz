import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { copyToClipboard } from '../../utils/copy'
import { Icon } from './Icon'
import { useToast } from './toast-store'

/** 组件级复制按钮：点击复制文本到剪贴板，成功短暂显示 ✓。 */
export function CopyButton({
  text,
  className = '',
  label,
}: {
  text: string
  className?: string
  label?: string
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const [copied, setCopied] = useState(false)

  async function onCopy() {
    const ok = await copyToClipboard(text)
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
      toast(t('common.copied'), 'success')
    } else {
      toast(t('common.copyFailed'), 'error')
    }
  }

  return (
    <button
      type="button"
      onClick={() => void onCopy()}
      title={t('common.copy')}
      className={`flex shrink-0 items-center gap-1 text-xs text-text-secondary transition-colors hover:text-text-primary ${className}`}
    >
      <Icon name={copied ? 'check' : 'copy'} size={13} className={copied ? 'text-success' : ''} />
      {label && <span>{label}</span>}
    </button>
  )
}
