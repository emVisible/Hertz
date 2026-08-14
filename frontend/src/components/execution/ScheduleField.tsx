import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button, useToast } from '../ui'
import { pipelineApi } from '../../api'

/** 排期设置字段（审核/发布卡片共用，AXIOM §1.2 单一真相源）。
 *  v0.11.5：date 升级为 datetime-local（可精确到分钟，不再固定 10:00）；
 *  推荐按钮回填完整时刻（本地排期引擎：当天优先 + 流量高峰窗口）；
 *  高峰快捷点：今天 10:00/12:00/18:00/20:00（仅未来可选，即点即选）。 */
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

  const pad = (n: number) => String(n).padStart(2, '0')
  const now = new Date()
  const todayIso = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const nowInput = toLocalInput(now.toISOString())

  /** ISO → datetime-local（本地时区显示） */
  function toLocalInput(iso: string): string {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ''
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  const scheduled = scheduledAt ? toLocalInput(scheduledAt) : null
  const current = draft ?? scheduled ?? ''

  // 高峰快捷点（v0.11.5）：仅保留今天未来时刻
  const peaks = [10, 12, 18, 20]
    .map((h) => ({ label: `${todayIso.slice(5)} ${pad(h)}:00`, value: `${todayIso}T${pad(h)}:00` }))
    .filter((p) => p.value > nowInput)

  async function suggest() {
    setSuggesting(true)
    try {
      const res = await pipelineApi.nextScheduleSlot()
      const local = toLocalInput(res.recommended_at)
      if (!local) return
      // 推荐槽位若已过期（跨日边界）→ 顺延到本地当前时刻 + 5 分钟
      setDraft(local < nowInput ? toLocalInput(new Date(Date.now() + 5 * 60_000).toISOString()) : local)
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
        type="datetime-local"
        aria-label={t('console.schedule')}
        value={current}
        min={nowInput}
        onChange={(e) => setDraft(e.target.value)}
        className="h-7 border border-border bg-surface-1 px-2 text-xs text-text-primary outline-none focus:border-primary"
      />
      <Button size="sm" variant="ghost" disabled={suggesting} onClick={() => void suggest()} title={t('console.scheduleSuggestHint')}>
        {t('console.scheduleSuggest')}
      </Button>
      {/* 高峰快捷点（v0.11.5）：流量高峰时段即点即选 */}
      {peaks.map((p) => (
        <button
          key={p.value}
          type="button"
          onClick={() => setDraft(p.value)}
          className={`border px-1.5 py-0.5 text-[10px] transition-colors ${
            current === p.value
              ? 'border-primary/50 bg-primary/15 font-medium text-primary'
              : 'border-border text-text-secondary hover:border-primary hover:text-primary'
          }`}
        >
          {p.label}
        </button>
      ))}
      <Button
        size="sm"
        variant="ghost"
        disabled={!draft}
        onClick={() => {
          // 完整时刻提交（ISO）；取消选中=清空排期
          onSave(draft ? new Date(draft).toISOString() : '')
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
