import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '../ui'
import { pipelineApi } from '../../api'

/** 排期设置字段（审核/发布卡片共用，AXIOM §1.2 单一真相源）：
 *  datetime-local + 保存；scheduled_at 已有值时显示「已设排期」。
 *  「推荐」按钮走本地排期引擎（窗口 + 最小间隔 + 抖动），推荐值回填草稿。 */
export function ScheduleField({
  scheduledAt,
  onSave,
}: {
  scheduledAt: string | null
  onSave: (value: string | null) => void
}) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<string | null>(null)
  const [suggesting, setSuggesting] = useState(false)
  const scheduled = scheduledAt ? scheduledAt.slice(0, 16) : null

  async function suggest() {
    setSuggesting(true)
    try {
      const res = await pipelineApi.nextScheduleSlot()
      // datetime-local 需要本地时间（去时区偏移）
      const local = new Date(res.recommended_at)
      const pad = (n: number) => String(n).padStart(2, '0')
      setDraft(
        `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}T${pad(local.getHours())}:${pad(local.getMinutes())}`,
      )
    } catch {
      /* 推荐失败静默——手动输入仍可用 */
    } finally {
      setSuggesting(false)
    }
  }

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
      <Button size="sm" variant="ghost" disabled={suggesting} onClick={() => void suggest()} title={t('console.scheduleSuggestHint')}>
        {t('console.scheduleSuggest')}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => { onSave(draft || null); setDraft(null) }}>
        {t('console.scheduleSave')}
      </Button>
      {scheduled && !draft && (
        <span className="text-[10px] text-text-disabled">{t('console.scheduleSet')}</span>
      )}
    </div>
  )
}
