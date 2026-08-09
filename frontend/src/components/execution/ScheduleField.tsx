import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button, useToast } from '../ui'
import { pipelineApi } from '../../api'

/** 排期设置字段（审核/发布卡片共用，AXIOM §1.2 单一真相源）：
 *  v0.2.6：仅日期（date），默认当前年/月，min=今天（不能排到过去）；
 *  提交时取当日 10:00（与日历拖拽/排期引擎同语义）。
 *  「推荐」按钮走本地排期引擎（窗口 + 最小间隔 + 抖动），推荐值回填。 */
export function ScheduleField({
  scheduledAt,
  onSave,
}: {
  scheduledAt: string | null
  onSave: (value: string) => void
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const [draft, setDraft] = useState<string | null>(null)
  const [suggesting, setSuggesting] = useState(false)

  const today = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const todayIso = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`
  const scheduled = scheduledAt ? scheduledAt.slice(0, 10) : null
  const current = draft ?? scheduled ?? ''

  async function suggest() {
    setSuggesting(true)
    try {
      const res = await pipelineApi.nextScheduleSlot()
      // 推荐槽位 → 本地日期（时区偏移转换）
      const local = new Date(res.recommended_at)
      if (Number.isNaN(local.getTime())) return
      const iso = `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}`
      setDraft(iso < todayIso ? todayIso : iso)
    } catch (err) {
      // §4.4 异步失败不沉默：推荐失败给出可读提示，手动输入仍可用
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setSuggesting(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[10px] uppercase tracking-wide text-text-disabled">{t('console.schedule')}</span>
      <input
        type="date"
        aria-label={t('console.schedule')}
        value={current}
        min={todayIso}
        onChange={(e) => setDraft(e.target.value)}
        className="h-7 border border-border bg-surface-1 px-2 text-xs text-text-primary outline-none focus:border-primary"
      />
      <Button size="sm" variant="ghost" disabled={suggesting} onClick={() => void suggest()} title={t('console.scheduleSuggestHint')}>
        {t('console.scheduleSuggest')}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={!draft}
        onClick={() => {
          // 提交当日 10:00（与日历拖拽/排期引擎同语义）；取消选中=清空排期
          onSave(draft ? `${draft}T10:00` : '')
          setDraft(null)
        }}
      >
        {t('console.scheduleSave')}
      </Button>
      {scheduled && !draft && (
        <span className="text-[10px] text-text-disabled">{t('console.scheduleSet')}</span>
      )}
    </div>
  )
}
