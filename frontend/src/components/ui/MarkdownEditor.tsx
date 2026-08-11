import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'

import { Icon } from './Icon'

/** Markdown 双栏编辑器（v0.8 提取）：左 raw 右预览，统一全项目 4 处同构实现。 */
export function MarkdownEditor({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (next: string) => void
  placeholder?: string
}) {
  const { t } = useTranslation()
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <h2 className="text-sm font-semibold">{t('briefs.content')}</h2>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1 text-xs text-text-secondary">
            <Icon name="edit" size={12} aria-hidden />
            {t('briefs.raw')}
          </span>
          <span className="flex items-center gap-1 text-xs text-text-secondary">
            <Icon name="eye" size={12} aria-hidden />
            {t('briefs.preview')}
          </span>
          <span className="text-xs text-text-disabled">
            {t('briefs.charCount', { count: value.length })}
          </span>
        </div>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-2">
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          className="min-h-0 resize-none overflow-y-auto bg-transparent p-3 font-mono text-sm leading-relaxed text-text-primary outline-none placeholder:text-text-disabled"
          placeholder={placeholder}
        />
        <div className="min-h-0 overflow-y-auto border-t border-border p-3 md:border-l md:border-t-0">
          <div className="md-body">
            <ReactMarkdown>{value || placeholder || ''}</ReactMarkdown>
          </div>
        </div>
      </div>
    </div>
  )
}
