import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { copyToClipboard } from '../../utils/copy'
import { Button, Icon } from './'

/**
 * 查询失败的统一错误态（AXIOM §22.2）：图标 + 可读信息 + 重试。
 * 页面 useQuery 的 isError 分支用它；无 onRetry 时仅展示。
 * 错误信息可一键复制，方便直接粘贴调试（用户反馈：所有错误信息都要能复制）。
 */
export function QueryErrorState({ message, onRetry }: { message?: string; onRetry?: () => void }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const text = message ?? t('error.unexpected')
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <Icon name="alert" size={28} className="text-error" />
      <p className="max-w-md text-sm leading-relaxed text-text-secondary">{text}</p>
      <div className="flex items-center gap-2">
        {onRetry && (
          <Button size="sm" onClick={onRetry}>
            <Icon name="refresh" size={14} />
            {t('common.retry')}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            void copyToClipboard(text).then((ok) => setCopied(ok))
            setTimeout(() => setCopied(false), 1200)
          }}
        >
          <Icon name={copied ? 'check' : 'copy'} size={14} />
          {copied ? t('common.copied') : t('common.copy')}
        </Button>
      </div>
    </div>
  )
}
