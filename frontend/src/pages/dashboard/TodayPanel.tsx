/** 今日作战台（v0.34 看板重设计）：目标 + 今天要动的条目 + 今日已发，**一块**。
 *
 * 用户两次纠正定下的形状：
 * ① 「每日目标和今日待办实际上是一个东西」——所以目标不是另一张卡片，它就是这块的
 *    标题；完成度是标题右边的一个数；条目是正文。三者是同一件事的三个面。
 * ② 「看板只是显示，它不做设置」——所以这里**没有**编辑目标的输入框；写目标的地方在
 *    顶级「设置 → 每日目标」（`sections/GoalSection.tsx`）。这里只给一条跳转出路。
 *
 * 条目动作留着（过审 / 制作 / 发布 / 移出今日 / 加工备注）：那是「作战台」存在的理由，
 * 属于「做事」不属于「设置」。组件复用流水线那批卡片，所以仍然只有一套发布入口。
 *
 * 列的划分与完成度的数都来自后端 `pipeline/board.py`——前端不分列、不自计。
 */

import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { pipelineApi, type PipelineItem } from '../../api'
import { Button, Icon, QueryErrorState } from '../../components/ui'
import { wallDay } from '../../core/boardWindow'
import type { BoardActions } from './boardActions'
import { ItemCard } from './shared'

/** 今日关注的局部 PATCH：`patch` 形状就是后端那个请求体，壳里一处 mutation。 */
export type FocusPatch = { focus_date?: string | null; focus_note?: string | null }

interface TodayPanelProps {
  p: BoardActions
  /** 写 focus（捞入/移出/改备注）由壳统一发起——供给栏也要捞入，两边各挂一个
   *  mutation 就会漂成两套失效逻辑（「state 留壳」D-183）。 */
  onFocus: (item: PipelineItem, patch: FocusPatch) => void
  /** 空态动线：设轴 + 切分段 + 换 tab，一次做完（`goUnscoredPatch`）。 */
  onGoUnscored: () => void
  /** 去「设置 → 每日目标」写今天的目标。 */
  onGoGoal: () => void
}

export function TodayPanel({ p, onFocus, onGoUnscored, onGoGoal }: TodayPanelProps) {
  const { t } = useTranslation()
  const [day, setDay] = useState(() => wallDay())
  const boardQuery = useQuery({ queryKey: ['pipeline-board', day], queryFn: () => pipelineApi.board(day) })
  const data = boardQuery.data

  const focus = data?.columns.focus ?? []
  const published = data?.columns.published_today ?? []
  const goal = (data?.goal_text ?? '').trim()

  return (
    <section className="rounded border border-border bg-surface-1/60">
      {/* 标题区 = 当日目标（只读）。它不是一个「模块」，就是这一块在回答「今天做什么」。 */}
      <header className="flex flex-wrap items-start gap-x-4 gap-y-2 border-b border-border/60 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-medium uppercase tracking-wide text-text-disabled">
              {t('console.boardColFocus')}
            </span>
            <input
              type="date"
              aria-label={t('console.boardDay')}
              value={day}
              onChange={(e) => setDay(e.target.value)}
              className="rounded border border-border bg-surface-1 px-1.5 py-0.5 text-[11px] text-text-secondary"
            />
            {day !== wallDay() && (
              <Button size="sm" variant="ghost" onClick={() => setDay(wallDay())}>
                {t('console.boardToday')}
              </Button>
            )}
          </div>
          {goal ? (
            <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-text-primary">{goal}</p>
          ) : (
            <p className="mt-1.5 text-sm text-text-disabled">
              {t('dashboard.goalEmpty')}{' '}
              <button type="button" onClick={onGoGoal} className="text-primary underline-offset-2 hover:underline">
                {t('dashboard.goalGo')}
              </button>
            </p>
          )}
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1">
          <span
            className="font-mono text-lg leading-none text-text-primary"
            title={t('console.boardProgress', {
              published: data?.progress.published_of_focus ?? 0,
              focused: data?.progress.focused ?? 0,
            })}
          >
            {data?.progress.published_of_focus ?? 0}
            <span className="text-text-disabled"> / {data?.progress.focused ?? 0}</span>
          </span>
          <span className="text-[10px] text-text-disabled">{t('dashboard.progressHint')}</span>
          {data?.goal_updated_at && (
            <button
              type="button"
              onClick={onGoGoal}
              className="font-mono text-[10px] text-text-disabled transition-colors hover:text-primary"
            >
              {t('console.boardGoalSavedAt', { at: new Date(data.goal_updated_at).toLocaleString() })}
            </button>
          )}
          <button
            type="button"
            onClick={() => void boardQuery.refetch()}
            title={t('console.boardRefresh')}
            className="text-text-disabled transition-colors hover:text-primary"
          >
            <Icon name="refresh" size={12} />
          </button>
        </div>
      </header>

      {boardQuery.isError && (
        <QueryErrorState message={t('console.boardLoadFailed')} onRetry={() => void boardQuery.refetch()} />
      )}

      <div className="flex flex-col gap-2 p-3">
        {focus.length === 0 && (
          <div className="flex items-center justify-between gap-3 rounded border border-dashed border-border/70 px-3 py-4">
            <span className="text-xs text-text-secondary">{t('console.boardEmptyFocus')}</span>
            <Button size="sm" variant="primary" onClick={onGoUnscored}>
              {t('console.boardGoPreReview')}
            </Button>
          </div>
        )}
        {focus.map((item) => (
          <FocusRow
            key={item.id}
            item={item}
            p={p}
            day={day}
            onDrop={() => onFocus(item, { focus_date: null })}
            onSaveNote={(note) => onFocus(item, { focus_date: item.focus_date ?? day, focus_note: note })}
          />
        ))}
      </div>

      {/* 今日已发：从一整列压成一条 chip 带——今天发出去几条是这块的收尾，不另起一模块 */}
      <div className="flex flex-wrap items-center gap-2 border-t border-border/60 px-4 py-2.5">
        <span className="text-[11px] text-text-disabled">{t('console.boardColPublished')}</span>
        {published.length === 0 ? (
          <span className="text-[11px] text-text-disabled">—</span>
        ) : (
          published.map((item) => (
            <span
              key={item.id}
              className="flex items-center gap-1.5 rounded border border-border px-2 py-0.5 text-[11px] text-text-secondary"
            >
              <span className="max-w-40 truncate">{item.title}</span>
              <button
                type="button"
                title={t('console.backToReviewHint')}
                onClick={() => void p.act(item, 'requeue')}
                className="text-text-disabled transition-colors hover:text-primary"
              >
                <Icon name="rewind" size={11} />
              </button>
              <button
                type="button"
                title={t('console.statsHint')}
                onClick={() => void p.setPublishStats(item)}
                className="text-text-disabled transition-colors hover:text-primary"
              >
                <Icon name="tag" size={11} />
              </button>
            </span>
          ))
        )}
      </div>
    </section>
  )
}

/** 今日列里的一条：备注长在卡片上，动作按它自己的状态给（`ItemCard` 一处分派）。 */
function FocusRow({
  item,
  p,
  day,
  onDrop,
  onSaveNote,
}: {
  item: PipelineItem
  p: BoardActions
  day: string
  onDrop: () => void
  onSaveNote: (note: string) => void
}) {
  const { t } = useTranslation()
  const [noteDraft, setNoteDraft] = useState<string | null>(null)
  const shownNote = noteDraft ?? item.focus_note ?? ''

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 px-2">
        <input
          aria-label={t('console.boardNoteLabel')}
          value={shownNote}
          placeholder={t('console.boardNotePlaceholder')}
          onChange={(e) => setNoteDraft(e.target.value)}
          onBlur={() => {
            if (noteDraft !== null && noteDraft !== (item.focus_note ?? '')) onSaveNote(noteDraft)
            setNoteDraft(null)
          }}
          className="min-w-0 flex-1 rounded border border-border/70 bg-surface-0 px-2 py-1 text-xs text-text-primary outline-none focus:border-primary"
        />
        <Button size="sm" variant="ghost" onClick={onDrop} title={t('console.boardDropHint', { day })}>
          {t('console.boardRemoveToday')}
        </Button>
      </div>
      <ItemCard item={item} p={p} />
    </div>
  )
}
