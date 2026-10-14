/**
 * 大纲面板（Phase 4）。
 *
 * 挂在编辑器上方：长稿的"地图"。点一项跳到对应行，光标移动时反向高亮当前标题——
 * 后者是它区别于一个静态目录的地方：大纲会告诉你"你在哪"，而不只是"有什么"。
 */
import { useTranslation } from 'react-i18next'
import { Icon } from '../../../components/ui'

import { outlineIndentLevel, type OutlineItem } from './outline'

interface OutlinePanelProps {
  items: OutlineItem[]
  /** 当前光标所在标题的文本（反向高亮） */
  activeText?: string | null
  onPick: (item: OutlineItem) => void
  onClose?: () => void
}

export function OutlinePanel({ items, activeText, onPick, onClose }: OutlinePanelProps) {
  const { t } = useTranslation()
  if (items.length === 0) {
    return (
      <div className="border-b border-border px-3 py-2 text-[11px] text-text-secondary" data-testid="mdstudio-outline">
        {t('mdstudio.outline.empty')}
      </div>
    )
  }
  return (
    <div className="border-b border-border" data-testid="mdstudio-outline">
      <div className="flex items-center gap-1.5 px-3 pb-1 pt-2">
        <Icon name="list" size={11} className="text-text-secondary" />
        <span className="flex-1 text-[11px] font-semibold text-text-secondary">{t('mdstudio.outline.title')}</span>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label={t('mdstudio.outline.close')}
            className="rounded p-0.5 text-text-disabled transition-colors hover:text-text-primary"
          >
            <Icon name="close" size={11} />
          </button>
        )}
      </div>
      <ul className="max-h-40 overflow-y-auto pb-1.5">
        {items.map((item) => {
          const active = activeText === item.text
          return (
            <li key={`${item.line}-${item.text}`}>
              <button
                type="button"
                data-testid={`outline-item-${item.line}`}
                aria-current={active}
                onClick={() => onPick(item)}
                title={item.text}
                style={{ paddingLeft: `${8 + outlineIndentLevel(item) * 12}px` }}
                className={`block w-full truncate py-0.5 pr-2 text-left text-[11px] transition-colors ${
                  active ? 'bg-primary/10 font-medium text-primary' : 'text-text-secondary hover:bg-surface-2 hover:text-text-primary'
                }`}
              >
                {item.text}
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}