/** 看板 tab（v0.34 B）：每日目标 + 五列（今日待办 / 在制 / 待审 / 待发布 / 今日已发）。
 *
 * 它**替换**原发布 tab（tab 数 6→6，不是加在旁边）：发布 tab 的实际内容就是
 * `stageApproved` / `stagePublished` 两张列表，正是这里的「待发布」与「今日已发」两列，
 * 卡片组件复用同一批（`PublishCard` / `AuditCard` / `StageItemRow`），所以不产生第二套发布入口。
 * 队列与日历两个视图按用户定档撤销（「全部手动发」），撤的是界面不是字段：
 * `queue_phase` / `scheduled_at` 的读写口都还在（见 spec §4.4）。
 *
 * 取数自持（照原 `CalendarView` 的先例）：看板的参数是「哪一天」，不是 tab state，
 * 塞进主壳 props 只会让 `usePipelineExecution` 多背一层搬运。
 * 列的划分**不在这里**——唯一作者是后端 `pipeline/board.py`，前端再分一次就会漂成
 * 两套「什么叫今日待办」。
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { pipelineApi, type BoardColumn, type PipelineItem } from '../../../api'
import { Badge, Button, Icon, QueryErrorState } from '../../../components/ui'
import { AuditCard, PublishCard, StageItemRow } from '../../../components/execution'
import { GOAL_MAX_CHARS, wallDay } from '../../../core/boardWindow'
import type { PipelineViewProps } from './shared'

/** 列顺序 = 工作流顺序（从「今天要动它」到「今天已经发出去」）。 */
const COLUMN_ORDER: BoardColumn[] = ['focus', 'in_work', 'review', 'ready_to_publish', 'published_today']

const COLUMN_LABEL_KEY: Record<BoardColumn, string> = {
  focus: 'console.boardColFocus',
  in_work: 'console.boardColInWork',
  review: 'console.boardColReview',
  ready_to_publish: 'console.boardColReady',
  published_today: 'console.boardColPublished',
}

interface BoardTabProps {
  p: PipelineViewProps
  /** 空态动线：切到未评分区并带上「情感 + 有正文」两轴。
   *  必须由主壳来 compose——`preStage`（未评分/已下载/已评分三个次级分段）的作者
   *  是 `PipelineView` 的 local state（「state 留壳」D-183），看板去猜它等于开第二作者，
   *  而只设轴不切分段的话用户会落在「已下载未加工」上，看不到那份筛选条。 */
  onGoUnscored: () => void
}

export function BoardTab({ p, onGoUnscored }: BoardTabProps) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [day, setDay] = useState(() => wallDay())
  const boardQuery = useQuery({
    queryKey: ['pipeline-board', day],
    queryFn: () => pipelineApi.board(day),
  })
  const data = boardQuery.data

  const stored = data?.goal_text ?? ''
  /** 目标草稿 = 「哪天 + 改没改过」两件事合在一起的一份状态。
   *
   * 为什么不是 `useState(text)` + 一个「数据到了就同步」的 effect：那样要么在
   * refetch 时吃掉用户正在打的字，要么（更坏）**换过日期之后仍然拿着上一天的草稿**——
   * 界面上显示的是新一天的目标，点保存写进库里的却是上一天的文字。带上 `day`
   * 之后这件事在类型里就不可能发生了：`edit.day !== day` 时草稿自动作废。 */
  const [edit, setEdit] = useState<{ day: string; text: string | null }>({ day, text: null })
  const shownGoal = edit.day === day ? (edit.text ?? stored) : stored
  const goalDirty = shownGoal !== stored

  const goalMut = useMutation({
    mutationFn: (text: string) => pipelineApi.saveGoal(day, text),
    // 保存成功判据 = 后端**回读**的那一行（不是「请求发出去了」）：D-204 的教训是
    // toast 说已保存而其实没落盘。`put_goal` 提交后 refresh 过，回读到的就是库里的值。
    onSuccess: () => {
      setEdit({ day, text: null })
      void qc.invalidateQueries({ queryKey: ['pipeline-board'] })
    },
  })

  const focusMut = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: { focus_date?: string | null; focus_note?: string | null } }) =>
      pipelineApi.setFocus(id, patch),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['pipeline-board'] }),
  })

  const pickToday = (item: PipelineItem) =>
    focusMut.mutate({ id: item.id, patch: { focus_date: day } })
  const dropToday = (item: PipelineItem) =>
    focusMut.mutate({ id: item.id, patch: { focus_date: null } })
  const saveNote = (item: PipelineItem, note: string) =>
    focusMut.mutate({
      id: item.id,
      patch: { focus_date: item.focus_date ?? day, focus_note: note },
    })

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* 顶栏：哪一天 + 完成度（真实已发数，不是手勾） */}
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="date"
          aria-label={t('console.boardDay')}
          value={day}
          onChange={(e) => setDay(e.target.value)}
          className="rounded border border-border bg-surface-1 px-2 py-1 text-xs text-text-primary"
        />
        {day !== wallDay() && (
          <Button size="sm" variant="ghost" onClick={() => setDay(wallDay())}>
            {t('console.boardToday')}
          </Button>
        )}
        <span className="text-xs text-text-secondary">
          {t('console.boardProgress', {
            published: data?.progress.published_of_focus ?? 0,
            focused: data?.progress.focused ?? 0,
          })}
        </span>
        {data?.goal_updated_at && (
          <span className="font-mono text-[10px] text-text-disabled">
            {t('console.boardGoalSavedAt', {
              at: new Date(data.goal_updated_at).toLocaleString(),
            })}
          </span>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          onClick={() => void boardQuery.refetch()}
          title={t('console.boardRefresh')}
        >
          <Icon name="refresh" size={12} />
        </Button>
      </div>

      {boardQuery.isError && (
        <QueryErrorState message={t('console.boardLoadFailed')} onRetry={() => void boardQuery.refetch()} />
      )}

      {/* 每日目标：纯文字 to-do，不自动联网、不触发采集（spec §4.1） */}
      <div className="rounded border border-border bg-surface-1/60 p-3">
        <label className="mb-1.5 block text-xs font-medium text-text-secondary" htmlFor="hz-goal">
          {t('console.boardGoalLabel')}
        </label>
        <textarea
          id="hz-goal"
          rows={3}
          maxLength={GOAL_MAX_CHARS}
          value={shownGoal}
          placeholder={t('console.boardGoalPlaceholder')}
          onChange={(e) => setEdit({ day, text: e.target.value })}
          className="w-full resize-y rounded border border-border bg-surface-0 px-2 py-1.5 text-sm text-text-primary outline-none focus:border-primary"
        />
        <div className="mt-1.5 flex items-center gap-2">
          <Button
            size="sm"
            variant={goalDirty ? 'primary' : 'ghost'}
            disabled={!goalDirty || goalMut.isPending}
            onClick={() => goalMut.mutate(shownGoal)}
          >
            {goalMut.isPending ? t('console.boardGoalSaving') : t('console.boardGoalSave')}
          </Button>
          <span className="text-[10px] text-text-disabled">
            {t('console.boardGoalLimit', { max: GOAL_MAX_CHARS })}
          </span>
          {goalMut.data && !goalDirty && (
            <Badge tone="success">{t('console.boardGoalSaved')}</Badge>
          )}
          {goalMut.isError && (
            <Badge tone="error">{t('console.boardGoalSaveFailed')}</Badge>
          )}
        </div>
      </div>

      {COLUMN_ORDER.map((column) => {
        const rows = data?.columns[column] ?? []
        const total = data?.counts[column] ?? 0
        return (
          <section key={column} className="rounded border border-border bg-surface-1/40">
            <header className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
              <h3 className="text-xs font-medium text-text-primary">{t(COLUMN_LABEL_KEY[column])}</h3>
              <Badge tone="neutral">{total}</Badge>
              {total > rows.length && (
                <span className="text-[10px] text-text-disabled">
                  {t('console.boardTruncated', { shown: rows.length, total })}
                </span>
              )}
            </header>

            {column === 'ready_to_publish' && p.publishStatus && (
              <PublishStatusLine status={p.publishStatus} />
            )}

            <div className="flex flex-col gap-2 p-2">
              {rows.length === 0 && column === 'focus' && (
                <FocusEmptyState onGo={onGoUnscored} />
              )}
              {rows.length === 0 && column !== 'focus' && (
                <p className="px-2 py-3 text-xs text-text-disabled">{t('console.boardColumnEmpty')}</p>
              )}
              {rows.map((item) => (
                <BoardRow
                  key={`${column}-${item.id}`}
                  column={column}
                  item={item}
                  day={day}
                  p={p}
                  onPick={() => pickToday(item)}
                  onDrop={() => dropToday(item)}
                  onSaveNote={(note) => saveNote(item, note)}
                />
              ))}
              {/* 批量发布仍在「运行 → publish」：看板承载逐条手动发（原发布 tab 页脚
                  那条提示跟着列搬过来，不留孤儿文案） */}
              {column === 'ready_to_publish' && (
                <p className="border-t border-border/60 px-2 pt-2 text-[10px] text-text-disabled">
                  {t('console.publishHint')}
                </p>
              )}
            </div>
          </section>
        )
      })}
    </div>
  )
}

/** 发布目标状态（原发布 tab 顶部那条警示，跟着「待发布」列走，不留孤儿告警）。 */
function PublishStatusLine({ status }: { status: NonNullable<PipelineViewProps['publishStatus']> }) {
  const { t } = useTranslation()
  const warn = status.noop || (status.target === 'bilibili' && !status.cookie_exists)
  return (
    <div
      className={`flex items-start gap-2 border-b px-3 py-2 text-xs ${
        warn ? 'border-warning/40 bg-warning/10 text-warning' : 'border-border/60 text-text-secondary'
      }`}
    >
      <Icon name="config" size={13} className="mt-0.5 shrink-0" />
      <div className="min-w-0">
        {status.noop ? (
          <>
            <span className="font-medium">{t('console.publishNoopTitle')}</span>
            <span className="ml-2">{t('console.publishNoopHint')}</span>
          </>
        ) : status.target === 'bilibili' && !status.cookie_exists ? (
          <>
            <span className="font-medium">
              {t('console.publishCookieMissing')} — {status.cookie_path}
            </span>
            <span className="ml-2">{t('console.publishCookieHint')}</span>
          </>
        ) : (
          <>
            <span className="font-medium">
              {t('console.publishReady')} → {status.target}
            </span>
            {status.target === 'bilibili' && <span className="ml-2">{t('console.publishCookieReady')}</span>}
          </>
        )}
      </div>
    </div>
  )
}

function FocusEmptyState({ onGo }: { onGo: () => void }) {
  const { t } = useTranslation()
  // 空态不是「暂无数据」死路：今日一列空 = 还没捞素材，动线就在隔壁 tab。
  return (
    <div className="flex items-center justify-between gap-3 rounded border border-dashed border-border/70 px-3 py-3">
      <span className="text-xs text-text-secondary">{t('console.boardEmptyFocus')}</span>
      <Button size="sm" variant="primary" onClick={onGo}>
        {t('console.boardGoPreReview')}
      </Button>
    </div>
  )
}

interface BoardRowProps {
  column: BoardColumn
  item: PipelineItem
  day: string
  p: PipelineViewProps
  onPick: () => void
  onDrop: () => void
  onSaveNote: (note: string) => void
}

function BoardRow({ column, item, day, p, onPick, onDrop, onSaveNote }: BoardRowProps) {
  const { t } = useTranslation()
  const [noteDraft, setNoteDraft] = useState<string | null>(null)
  const shownNote = noteDraft ?? item.focus_note ?? ''

  const pickButton =
    column !== 'focus' && column !== 'published_today' ? (
      <Button size="sm" variant="ghost" onClick={onPick} title={t('console.boardPickHint')}>
        {t('console.boardPickToday')}
      </Button>
    ) : null

  const body =
    column === 'ready_to_publish' || (column === 'focus' && item.status === 'approved') ? (
      <PublishCard
        item={item}
        onPublish={(i, selfmade, target, now) => p.publishItem(i, selfmade, target, now)}
        onSaveMeta={(i, meta) => void p.saveMeta(i, meta)}
        onRequeue={(i) => void p.act(i, 'requeue')}
        onRandomCover={(i) => void p.randomCover(i)}
      />
    ) : column === 'review' || (column === 'focus' && item.status === 'queued') ? (
      <AuditCard
        item={item}
        onApprove={(i) => void p.act(i, 'approve')}
        onReject={(i) => void p.act(i, 'reject')}
        onUploadCover={(i, file) => void p.uploadCover(i, file)}
        onRandomCover={(i) => void p.randomCover(i)}
        onBackToPrep={(i) => void p.backToPrep(i)}
      />
    ) : (
      <StageItemRow
        item={item}
        badge={
          <span className="flex items-center gap-1">
            <Badge tone={column === 'published_today' ? 'success' : 'neutral'}>{item.status}</Badge>
            {item.published_at && (
              <span className="font-mono text-[10px] text-text-disabled">
                {new Date(item.published_at).toLocaleString()}
              </span>
            )}
          </span>
        }
        right={
          column === 'published_today' ? (
            <Button size="sm" variant="ghost" onClick={() => void p.act(item, 'requeue')}>
              {t('console.backToReview')}
            </Button>
          ) : pickButton
        }
      />
    )

  // 今日列把「加工备注」长在卡片上（用户：重质量、后面自己加工）
  if (column !== 'focus') {
    return <div className="flex flex-col gap-1">{body}</div>
  }
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
      {body}
    </div>
  )
}
