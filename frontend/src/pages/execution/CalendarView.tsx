import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import type { PipelineItem } from '../../api'
import { pipelineApi } from '../../api'
import { Badge, Button, Icon, useToast } from '../../components/ui'
import { PIPELINE_ITEM_TONE } from '../../components/execution'
import { monthGrid, shiftMonth, toLocalDate, toLocalDateFromIso } from './calendar'

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

/** 条目在日历上的落位日（排期优先，其次发布日） */
function itemDate(item: PipelineItem): string | null {
  return toLocalDateFromIso(item.scheduled_at) ?? toLocalDateFromIso(item.published_at)
}

function itemTime(item: PipelineItem): string | null {
  if (!item.scheduled_at) return null
  const d = new Date(item.scheduled_at)
  return Number.isNaN(d.getTime())
    ? null
    : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * 内容日历（v0.2.3，参考 Buffer/新榜）：月网格展示排期与发布记录，
 * 拖拽改期（落到「未排期」区 = 清空排期，复用 meta 清空语义）。
 * 单条「推荐排期」仍在列表视图的 ScheduleField（单一真相源，不在日历重复实现）。
 */
export function CalendarView({
  onSaveSchedule,
}: {
  onSaveSchedule: (item: PipelineItem, value: string) => Promise<unknown>
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const now = new Date()
  const [cursor, setCursor] = useState({ year: now.getFullYear(), month: now.getMonth() })
  const [dragId, setDragId] = useState<string | null>(null)

  const { year, month } = cursor
  const cells = useMemo(() => monthGrid(year, month), [year, month])
  // 查询范围覆盖整个 42 格网格（含上月前导格/下月尾随格）——
  // 拖到月外补位格设的排期不会因窗口外而「消失」（§35 数据完整）
  const from = cells[0].iso
  const to = cells[cells.length - 1].iso

  const { data, refetch } = useQuery({
    queryKey: ['pipeline-calendar', from, to],
    queryFn: () => pipelineApi.calendar(from, to),
  })
  const items = data?.items ?? []
  const unscheduled = data?.unscheduled ?? []

  const byDate = useMemo(() => {
    const map = new Map<string, PipelineItem[]>()
    for (const item of items) {
      const date = itemDate(item)
      if (!date) continue
      const list = map.get(date) ?? []
      if (list.length === 0) map.set(date, list)
      list.push(item)
    }
    return map
  }, [items])

  async function setSchedule(item: PipelineItem, dateIso: string | null) {
    try {
      // 先等 PUT 落库再 refetch——避免 GET 在提交前打到旧数据（§35 数据驱动）
      await onSaveSchedule(item, dateIso ? `${dateIso}T10:00` : '')
      await refetch()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  function onDrop(e: React.DragEvent, dateIso: string | null) {
    e.preventDefault()
    const id = e.dataTransfer.getData('text/plain') || dragId
    setDragId(null)
    const item = [...items, ...unscheduled].find((i) => i.id === id)
    if (!item) return
    void setSchedule(item, dateIso)
  }

  return (
    <div className="flex flex-col gap-2">
      {/* 月导航 */}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setCursor((c) => shiftMonth(c.year, c.month, -1))}
          title={t('console.calendarPrev')}
        >
          <Icon name="chevron-left" size={13} />
        </Button>
        <span className="min-w-24 text-center text-sm font-semibold text-text-primary">
          {year}-{String(month + 1).padStart(2, '0')}
        </span>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setCursor((c) => shiftMonth(c.year, c.month, 1))}
          title={t('console.calendarNext')}
        >
          <Icon name="chevron-right" size={13} />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setCursor({ year: now.getFullYear(), month: now.getMonth() })}
        >
          {t('console.calendarToday')}
        </Button>
        <p className="ml-auto text-[10px] text-text-disabled">{t('console.calendarDropHint')}</p>
      </div>

      {/* 月网格 */}
      <div className="grid grid-cols-7 gap-px border border-border bg-border">
        {WEEKDAYS.map((w) => (
          <div key={w} className="bg-surface-1 px-1.5 py-1 text-center text-[10px] font-medium uppercase tracking-wide text-text-disabled">
            {t(`console.calendarWeek.${w}`)}
          </div>
        ))}
        {cells.map((cell) => {
          const dayItems = byDate.get(cell.iso) ?? []
          const today = cell.iso === toLocalDate(new Date())
          return (
            <div
              key={cell.iso}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => onDrop(e, cell.iso)}
              className={`min-h-24 bg-surface-1 p-1 ${cell.inMonth ? '' : 'opacity-40'}`}
            >
              <div className={`flex items-center justify-between px-0.5 text-[10px] ${today ? 'font-bold text-primary' : 'text-text-disabled'}`}>
                {cell.day}
                {today && <span className="h-1 w-1 rounded-full bg-primary" />}
              </div>
              <div className="mt-0.5 flex flex-col gap-0.5">
                {dayItems.map((item) => (
                  <div
                    key={item.id}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/plain', item.id)
                      e.dataTransfer.effectAllowed = 'move'
                      setDragId(item.id)
                    }}
                    onDragEnd={() => setDragId(null)}
                    title={`${item.title}\n${itemDate(item) ?? ''}`}
                    className={`flex cursor-grab items-center gap-1 truncate border-l-2 px-1 py-0.5 text-[10px] transition-colors hover:bg-surface-2 ${
                      item.status === 'published'
                        ? 'border-emerald-400 text-text-secondary'
                        : 'border-warning text-text-primary'
                    }`}
                  >
                    {itemTime(item) && <span className="shrink-0 font-mono text-text-disabled">{itemTime(item)}</span>}
                    <span className="truncate">{item.title}</span>
                    {item.status === 'published' && (
                      <span className="ml-auto shrink-0 text-[9px] text-emerald-400">{t('console.calendarPublished')}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>

      {/* 未排期区（拖入 = 清空排期） */}
      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => onDrop(e, null)}
        className="border border-dashed border-border bg-surface-1/60 p-2"
      >
        <p className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-text-disabled">
          <Icon name="downloads" size={11} />
          {t('console.calendarUnscheduled')}
          <span className="ml-auto font-normal normal-case text-text-disabled/70">{t('console.calendarDropClear')}</span>
        </p>
        <div className="flex flex-wrap gap-1.5">
          {unscheduled.length === 0 && (
            <p className="text-[11px] text-text-disabled">{t('console.calendarNoUnscheduled')}</p>
          )}
          {unscheduled.map((item) => (
            <span
              key={item.id}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('text/plain', item.id)
                e.dataTransfer.effectAllowed = 'move'
                setDragId(item.id)
              }}
              onDragEnd={() => setDragId(null)}
              className="flex cursor-grab items-center gap-1.5 border border-border bg-surface-2 px-1.5 py-0.5 text-[11px] text-text-secondary transition-colors hover:border-text-disabled/50"
              title={item.title}
            >
              <Badge tone={PIPELINE_ITEM_TONE[item.status] ?? 'neutral'}>{item.status}</Badge>
              <span className="max-w-48 truncate">{item.title}</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
