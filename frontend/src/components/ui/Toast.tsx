import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { copyToClipboard } from '../../utils/copy'
import { Icon } from './Icon'
import { useToastStore } from './toast-store'

export function ToastProvider({ children }: { children: ReactNode }) {
  const { t: tCopy } = useTranslation()
  const toasts = useToastStore((s) => s.toasts)
  const dismiss = useToastStore((s) => s.dismiss)
  return (
    <>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={`hz-toast-in pointer-events-auto flex items-start gap-2  border border-border bg-surface-1 p-3 shadow-lg ${
              t.tone === 'error' ? 'border-error/40' : ''
            }`}
          >
            <span
              className={`mt-0.5 ${
                t.tone === 'error'
                  ? 'text-error'
                  : t.tone === 'success'
                    ? 'text-success'
                    : t.tone === 'warning'
                      ? 'text-warning'
                      : 'text-primary'
              }`}
            >
              <Icon name={t.tone === 'error' ? 'alert' : t.tone === 'info' ? 'info' : 'check'} size={14} />
            </span>
            <p className="flex-1 break-all text-sm text-text-primary">{t.message}</p>
            <button
              type="button"
              onClick={() => void copyToClipboard(t.message)}
              aria-label="Copy message"
              title={tCopy('common.copyTitle')}
              className="p-0.5 text-text-disabled transition-colors hover:text-text-primary"
            >
              <Icon name="copy" size={12} />
            </button>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss"
              className="p-0.5 text-text-disabled transition-colors hover:text-text-primary"
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        ))}
      </div>
    </>
  )
}
