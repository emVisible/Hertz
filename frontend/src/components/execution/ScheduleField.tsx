import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '../ui'

/** 排期设置字段（审核/发布卡片共用，AXIOM §1.2 单一真相源）：
 *  datetime-local + 保存；scheduled_at 已有值时显示「已设排期」。 */
export function ScheduleField({
  scheduledAt,
  onSave,
}: {
  scheduledAt: string | null
  onSave: (value: string | null) => void
}) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<string | null>(null)
  const scheduled = scheduledAt ? scheduledAt.slice(0, 16) : null

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[10px] uppercase tracking-wide text-text-disabled">{t('console.schedule')}</span>
      <input
        type="datetime-local"
        aria-label={t('console.schedule')}
        value={draft ?? scheduled ?? ''}
        onChange={(e) => setDraft(e.target.value)}
        className="h-7 border border-border bg-surface-1 px-2 text-xs text-text-primary outline-none focus:border-primary"
      />
      <Button size="sm" variant="ghost" onClick={() => { onSave(draft || null); setDraft(null) }}>
        {t('console.scheduleSave')}
      </Button>
      {scheduled && !draft && (
        <span className="text-[10px] text-text-disabled">{t('console.scheduleSet')}</span>
      )}
    </div>
  )
}
