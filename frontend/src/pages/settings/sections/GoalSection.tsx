/** 设置 ·「每日目标」（v0.34 看板重设计）：写某一天的文字目标，就这一件事。
 *
 * 为什么在设置而不是看板：用户定的是「看板只是显示，它不做设置」。看板那块的标题
 * 就是这段文字，并且**只多了一个动作**——逐条勾选完成（写回的还是同一段文本，
 * 判据在 `core/goalChecklist.ts`）；改文字这件事仍然只在这里做。两边同一张 `daily_goal` 表。
 *
 * 为什么不并进设置页那份大草稿（`buildOverrides` → runtime.yaml）：目标是**按天一行**
 * 存 Postgres，而设置页的保存是「把打开页面时的所有字段整体写回 runtime.yaml」。
 * 混在一起会有两个 bug：① 改了目标就点亮全局「有未保存修改」，别人格/别的分区被
 * 一次无关的「保存设置」连带写回；② 挂着设置页跨天不关，草稿里的日期还是昨天，
 * 点保存会把今天的想法写进昨天那一行。所以这里自持一份状态，一天一条自己存。
 */

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { pipelineApi } from '../../../api'
import { Button, Icon, QueryErrorState } from '../../../components/ui'
import { GOAL_MAX_CHARS, wallDay } from '../../../core/boardWindow'
import { clearGoalTicks } from '../../../core/goalChecklist'
import { heading, section, sub } from './shared'

export function GoalSection() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [day, setDay] = useState(() => wallDay())

  const goalQuery = useQuery({
    queryKey: ['daily-goal', day],
    queryFn: () => pipelineApi.goal(day),
  })
  /** D-220：清单长期一份。没写过的那一天沿用最近一份，并把勾洗掉——今天的完成
   *  要从今天开始数。洗法与勾选同一作者（`core/goalChecklist`），这里只决定"什么时候洗"：
   *  只有 `carried_from` 非空（不是那天自己那行）才洗，翻回历史某天要看它自己的勾。 */
  const carried = goalQuery.data?.carried_from ?? null
  const stored = goalQuery.data
    ? carried
      ? clearGoalTicks(goalQuery.data.goal_text)
      : goalQuery.data.goal_text
    : ''

  /** 草稿 = 「哪天 + 改没改过」合在一起的一份状态（不能拆成 `useState(text)` + 同步 effect）。
   *  带 `day` 之后「换过日期仍然拿着上一天的文字去保存」这件事在类型里就不可能发生了。 */
  const [edit, setEdit] = useState<{ day: string; text: string | null }>({ day, text: null })
  const shown = edit.day === day ? (edit.text ?? stored) : stored
  const dirty = shown !== stored

  const saveMut = useMutation({
    mutationFn: (text: string) => pipelineApi.saveGoal(day, text),
    // 成功判据是后端**回读**的那一行（`put_goal` 提交后 refresh 过），不是「请求发出去了」——
    // 界面上「已保存」而库里没落盘这种形状，只能靠回读堵住。
    onSuccess: () => {
      setEdit({ day, text: null })
      void qc.invalidateQueries({ queryKey: ['daily-goal'] })
      // 看板那块的标题读的是 `['pipeline-board', day]`，不一起失效就会停在旧目标上。
      void qc.invalidateQueries({ queryKey: ['pipeline-board'] })
    },
  })

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className={heading}>{t('settings.goalTitle')}</h2>
        <p className={sub}>{t('settings.goalHint')}</p>
      </div>

      <section className={section}>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <input
            type="date"
            aria-label={t('settings.goalDay')}
            value={day}
            onChange={(e) => setDay(e.target.value)}
            className="rounded border border-border bg-surface-0 px-2 py-1 text-xs text-text-primary outline-none focus:border-primary"
          />
          {day !== wallDay() && (
            <Button size="sm" variant="ghost" onClick={() => setDay(wallDay())}>
              {t('settings.goalToday')}
            </Button>
          )}
          {carried && (
            <span className="text-[10px] text-text-disabled">
              {t('dashboard.goalCarriedFrom', { day: carried })} · {t('dashboard.goalCarriedHint')}
            </span>
          )}
          <span className="ml-auto text-[10px] text-text-disabled">
            {shown.length} / {GOAL_MAX_CHARS}
          </span>
        </div>

        {goalQuery.isError ? (
          <QueryErrorState
            message={t('settings.goalLoadFailed')}
            onRetry={() => void goalQuery.refetch()}
          />
        ) : (
          <textarea
            aria-label={t('settings.goalLabel')}
            rows={10}
            value={shown}
            maxLength={GOAL_MAX_CHARS}
            placeholder={t('settings.goalPlaceholder')}
            onChange={(e) => setEdit({ day, text: e.target.value })}
            className="w-full resize-y rounded border border-border bg-surface-0 px-2.5 py-2 text-sm leading-relaxed text-text-primary outline-none focus:border-primary"
          />
        )}
        <p className="mt-1.5 flex items-center gap-1.5 text-[10px] text-text-disabled">
          <Icon name="console" size={11} />
          {t('settings.goalFootnote')}
        </p>
      </section>

      <div className="flex items-center gap-3">
        <Button
          onClick={() => saveMut.mutate(shown)}
          disabled={!dirty || saveMut.isPending || goalQuery.isFetching}
        >
          {t('settings.save')}
        </Button>
        {saveMut.isSuccess && <span className="text-xs text-emerald-400">{t('settings.goalSaved')}</span>}
        {saveMut.isError && <span className="text-xs text-error">{t('settings.goalSaveFailed')}</span>}
        <span className="text-xs text-text-disabled">{t('settings.goalSaveHint', { day })}</span>
      </div>
    </div>
  )
}
