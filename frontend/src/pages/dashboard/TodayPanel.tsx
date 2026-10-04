/** 「今日待办」悬浮栏（v0.34 D-219）：看板右侧那块常驻的目标清单。
 *
 * 用户的形状：「把这个今日待办做成一个悬浮的，放在看板右侧」+
 * 「原来今日待办下面那两个部分删掉，就保留上面的部分」——所以这里**只有**：
 * 哪一天、目标清单（一行一条待办，点一下打勾）、一个最简指标「今日已发 N」。
 * 删掉的是：条目列表（含「今天还没有捞入任何条目」那个空态动线）与今日已发那一排 chip。
 * 条目本来就在流水线上做事（D-218 把单条发布与捞入今日搬过去了），看板上不需要第二处。
 *
 * 仍然**不编辑目标文字**（textarea 只在「设置 → 每日目标」），这里只有勾选这一个写动作；
 * 勾选写回同一段文本，判据唯一作者 `core/goalChecklist.ts`。
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { pipelineApi } from '../../api'
import { Button, Icon, QueryErrorState } from '../../components/ui'
import { GOAL_MAX_CHARS, wallDay } from '../../core/boardWindow'
import { goalProgress, parseGoalLines, toggleGoalLine } from '../../core/goalChecklist'

export function TodayPanel({ onGoGoal }: { onGoGoal: () => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [day, setDay] = useState(() => wallDay())
  const boardQuery = useQuery({ queryKey: ['pipeline-board', day], queryFn: () => pipelineApi.board(day) })
  const data = boardQuery.data
  const stored = data?.goal_text ?? ''

  /** 勾选后的文本先留在本地（带 `day`，换日期自动作废），成功再拿**后端回读**那行覆盖。
   *  不做乐观写入的话，连点两下会以同一份旧文本各发一次 PUT，后一次把前一次的勾抹掉。 */
  const [local, setLocal] = useState<{ day: string; text: string | null }>({ day, text: null })
  const [overlong, setOverlong] = useState(false)
  const shownGoal = local.day === day ? (local.text ?? stored) : stored
  const lines = parseGoalLines(shownGoal)
  const todos = lines.filter((l) => !l.blank)
  const progress = goalProgress(lines)

  const goalMut = useMutation({
    mutationFn: (text: string) => pipelineApi.saveGoal(day, text),
    onSuccess: (row) => {
      setLocal({ day, text: row.goal_text })
      void qc.invalidateQueries({ queryKey: ['pipeline-board'] })
      void qc.invalidateQueries({ queryKey: ['daily-goal'] })
    },
    // 写失败就回到服务器上的真相：勾掉是假象，比不勾更坏
    onError: () => setLocal({ day, text: null }),
  })

  const toggle = (index: number) => {
    const next = toggleGoalLine(shownGoal, index)
    if (next === shownGoal) return
    if (next.length > GOAL_MAX_CHARS) {
      // 勾选会加 `- [x] ` 六个字，顶到上限时要给个说法，否则点了没反应会被读成坏了
      setOverlong(true)
      return
    }
    setOverlong(false)
    setLocal({ day, text: next })
    goalMut.mutate(next)
  }

  return (
    <section className="flex flex-col gap-2 rounded border border-border bg-surface-1 p-3 shadow-sm">
      <header className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto text-xs font-medium uppercase tracking-wide text-text-disabled">
          {t('console.boardColFocus')}
        </h2>
        <input
          type="date"
          aria-label={t('console.boardDay')}
          value={day}
          onChange={(e) => setDay(e.target.value)}
          className="rounded border border-border bg-surface-0 px-1.5 py-0.5 text-[11px] text-text-secondary"
        />
        {day !== wallDay() && (
          <Button size="sm" variant="ghost" onClick={() => setDay(wallDay())}>
            {t('console.boardToday')}
          </Button>
        )}
        <button
          type="button"
          onClick={() => void boardQuery.refetch()}
          title={t('console.boardRefresh')}
          className="text-text-disabled transition-colors hover:text-primary"
        >
          <Icon name="refresh" size={12} />
        </button>
      </header>

      {boardQuery.isError && (
        <QueryErrorState message={t('console.boardLoadFailed')} onRetry={() => void boardQuery.refetch()} />
      )}

      {/* 完成度：主数是待办勾了几条，副的只有一个最简指标「今日已发 N」 */}
      <div className="flex items-end justify-between gap-3 border-y border-border/60 py-2">
        <span className="font-mono text-xl leading-none text-text-primary">
          {progress.done}
          <span className="text-text-disabled"> / {progress.total}</span>
        </span>
        <span className="text-right text-[10px] leading-tight text-text-disabled">
          {t('dashboard.todoDone')}
          <br />
          {t('dashboard.publishedToday', { n: data?.progress.published_of_focus ?? 0 })}
        </span>
      </div>

      {todos.length === 0 ? (
        <p className="py-2 text-sm text-text-disabled">
          {t('dashboard.goalEmpty')}{' '}
          <button type="button" onClick={onGoGoal} className="text-primary underline-offset-2 hover:underline">
            {t('dashboard.goalGo')}
          </button>
        </p>
      ) : (
        <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto pr-0.5">
          {todos.map((line) => (
            <li key={line.index}>
              <label className="flex cursor-pointer items-start gap-2">
                <input
                  type="checkbox"
                  checked={line.done}
                  onChange={() => toggle(line.index)}
                  className="mt-1 h-3.5 w-3.5 shrink-0"
                  aria-label={t('dashboard.todoToggle', { text: line.content })}
                />
                <span
                  className={`min-w-0 text-sm leading-snug ${
                    line.done ? 'text-text-disabled line-through' : 'text-text-primary'
                  }`}
                >
                  {line.content}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}

      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-text-disabled">
        {goalMut.isError && <span className="text-error">{t('dashboard.goalSaveFailed')}</span>}
        {overlong && <span className="text-warning">{t('dashboard.goalTooLong', { max: GOAL_MAX_CHARS })}</span>}
        <button type="button" onClick={onGoGoal} className="transition-colors hover:text-primary">
          {t('dashboard.goalEditText')}
        </button>
        {data?.goal_updated_at && (
          <button
            type="button"
            onClick={onGoGoal}
            className="ml-auto font-mono transition-colors hover:text-primary"
          >
            {t('console.boardGoalSavedAt', { at: new Date(data.goal_updated_at).toLocaleDateString() })}
          </button>
        )}
      </p>
    </section>
  )
}
