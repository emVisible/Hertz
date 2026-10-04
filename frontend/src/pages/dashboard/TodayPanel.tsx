/** 看板 ·「今天」（v0.34 D-218）：目标清单 + 今日条目 + 今日已发，**一块**。
 *
 * 用户的两次纠正把这块钉成了现在的形状：
 * ① 「每日目标和今日待办实际上是一个东西」→ 目标不是另一张卡，它就是这块的正文；
 * ② 「每输入一行内容就代表一个待办事项……我每天能设置是否完成，点击一下我就完成了」
 *    → 目标文本按行渲染成可勾选清单，勾一下就是完成。
 *
 * 所以这块**只写两件事**：勾选状态（`PUT /goal/{day}`，把 `- [x]` 写回文本）与条目的
 * 今日关注（`p.setFocus`）。**改目标文字仍然不在看板上**——编辑在「设置 → 每日目标」，
 * 这里只给出路（空目标提示与「上次保存」都跳过去）。勾选状态为什么写进文本而不是
 * 另存一列，判据在 `core/goalChecklist.ts`。
 *
 * 列的划分与完成度的数都来自后端 `pipeline/board.py`——前端不分列、不自计。
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { pipelineApi, type PipelineItem } from '../../api'
import { Badge, Button, Icon, QueryErrorState } from '../../components/ui'
import { AuditCard, PublishCard, StageItemRow } from '../../components/execution'
import { GOAL_MAX_CHARS, wallDay } from '../../core/boardWindow'
import { goalProgress, parseGoalLines, toggleGoalLine } from '../../core/goalChecklist'
import type { BoardActions } from './boardActions'

interface TodayPanelProps {
  p: BoardActions
  /** 空态动线：设轴 + 切分段 + 换 tab，一次做完（`goUnscoredPatch`）。 */
  onGoUnscored: () => void
  /** 去「设置 → 每日目标」写目标文字。 */
  onGoGoal: () => void
}

export function TodayPanel({ p, onGoUnscored, onGoGoal }: TodayPanelProps) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [day, setDay] = useState(() => wallDay())
  const boardQuery = useQuery({ queryKey: ['pipeline-board', day], queryFn: () => pipelineApi.board(day) })
  const data = boardQuery.data
  const stored = data?.goal_text ?? ''

  /** 勾选后的文本先留在本地（带 `day`，换日期自动作废），成功再拿**后端回读**那行覆盖。
   *  不做乐观写入的话，连点两下会以同一份旧文本各发一次 PUT，后一次把前一次的勾抹掉；
   *  成功后若清空本地，缓存重取那一瞬勾会先掉再回来。 */
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
      // 设置页那份按天缓存也一起跟上，否则切过去还是旧文本
      void qc.invalidateQueries({ queryKey: ['daily-goal'] })
    },
    // 写失败就回到服务器上的真相，并说清楚没落盘（勾掉是假象比不勾更坏）
    onError: () => setLocal({ day, text: null }),
  })

  const toggle = (index: number) => {
    const next = toggleGoalLine(shownGoal, index)
    if (next === shownGoal) return
    if (next.length > GOAL_MAX_CHARS) {
      // 勾不上而不是发一个注定 422 的请求：勾选会加 `- [x] ` 六个字，顶到上限时
      // 界面上要有个说法，否则点着没反应看起来像坏了。
      setOverlong(true)
      return
    }
    setOverlong(false)
    setLocal({ day, text: next })
    goalMut.mutate(next)
  }

  const focus = data?.columns.focus ?? []
  const published = data?.columns.published_today ?? []

  return (
    <section className="rounded border border-border bg-surface-1/60">
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
        </div>

        <div className="flex shrink-0 flex-col items-end gap-0.5">
          <span
            className="font-mono text-lg leading-none text-text-primary"
            title={t('console.boardProgress', {
              published: data?.progress.published_of_focus ?? 0,
              focused: data?.progress.focused ?? 0,
            })}
          >
            {progress.done}
            <span className="text-text-disabled"> / {progress.total}</span>
          </span>
          <span className="text-[10px] text-text-disabled">{t('dashboard.todoDone')}</span>
          <span className="font-mono text-[10px] text-text-secondary">
            {t('console.boardProgress', {
              published: data?.progress.published_of_focus ?? 0,
              focused: data?.progress.focused ?? 0,
            })}
          </span>
          <div className="flex items-center gap-2">
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
        </div>
      </header>

      {boardQuery.isError && (
        <QueryErrorState message={t('console.boardLoadFailed')} onRetry={() => void boardQuery.refetch()} />
      )}

      {/* 目标清单：一行一条待办，点一下就是完成 */}
      <div className="border-b border-border/60 px-4 py-3">
        {todos.length === 0 ? (
          <p className="text-sm text-text-disabled">
            {t('dashboard.goalEmpty')}{' '}
            <button type="button" onClick={onGoGoal} className="text-primary underline-offset-2 hover:underline">
              {t('dashboard.goalGo')}
            </button>
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
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
                    className={`min-w-0 text-sm leading-relaxed ${
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
        <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-text-disabled">
          {goalMut.isError && <span className="text-error">{t('dashboard.goalSaveFailed')}</span>}
          {overlong && <span className="text-warning">{t('dashboard.goalTooLong', { max: GOAL_MAX_CHARS })}</span>}
          <button type="button" onClick={onGoGoal} className="transition-colors hover:text-primary">
            {t('dashboard.goalEditText')}
          </button>
        </p>
      </div>

      {/* 今日条目：从流水线「捞入今日」来的那些活儿，动作按状态给 */}
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
            onDrop={() => void p.setFocus(item, { focus_date: null })}
            onSaveNote={(note) => void p.setFocus(item, { focus_date: item.focus_date ?? day, focus_note: note })}
          />
        ))}
      </div>

      {/* 今日已发：压成一条 chip 带——今天发出去几条是这块的收尾，不另起一模块 */}
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

/** 今日列里的一条：备注长在卡片上，动作按条目自己的状态给。
 *  这一处是「哪种状态给哪张卡」的唯一作者——流水线那边用的是同一批卡片组件。 */
function ItemCard({ item, p }: { item: PipelineItem; p: BoardActions }) {
  if (item.status === 'approved') {
    return (
      <PublishCard
        item={item}
        onPublish={(i, selfmade, target, now) => p.publishItem(i, selfmade, target, now)}
        onSaveMeta={(i, meta) => void p.saveMeta(i, meta)}
        onRequeue={(i) => void p.act(i, 'requeue')}
        onRandomCover={(i) => void p.randomCover(i)}
      />
    )
  }
  if (item.status === 'queued') {
    return (
      <AuditCard
        item={item}
        onApprove={(i) => void p.act(i, 'approve')}
        onReject={(i) => void p.act(i, 'reject')}
        onUploadCover={(i, file) => void p.uploadCover(i, file)}
        onRandomCover={(i) => void p.randomCover(i)}
        onBackToPrep={(i) => void p.backToPrep(i)}
      />
    )
  }
  // 还在制（downloaded/scored）的只列出来：下载/制作的入口在流水线，抄一份按钮就是第二个写点
  return <StageItemRow item={item} badge={<Badge tone="neutral">{item.status}</Badge>} />
}

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
