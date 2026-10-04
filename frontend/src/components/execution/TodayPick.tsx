/** 「捞入今日」（v0.34 D-218）：流水线上把一条活儿挂到看板上那一天。
 *
 * 为什么在流水线而不是看板：看板那一侧只显示今天已经排好的东西，而**挑活儿**这个动作
 * 发生在他浏览列表的时候（未评分 / 已评分 / 待审 / 已过审待发）。从前它是看板上「待处理」
 * 那两列的按钮，用户明确说那两列不该在看板里，于是入口跟着动作搬到了做事的那一侧。
 *
 * `focus_date` 已经在序列化里（`service.py::_serialize`），所以「今天已经在今日里」
 * 是直接读得到的状态，不需要多一次请求；已在今日的行按钮置灰——写第二次没有意义，
 * 而点了没反应会被读成坏了。
 */

import { useTranslation } from 'react-i18next'

import type { PipelineItem } from '../../api'
import { Button, Icon } from '../ui'
import { wallDay } from '../../core/boardWindow'

export function TodayPick({
  item,
  day = wallDay(),
  onPick,
}: {
  item: PipelineItem
  /** 挂到哪一天（默认界面上的今天） */
  day?: string
  onPick: (item: PipelineItem, day: string) => void
}) {
  const { t } = useTranslation()
  const picked = item.focus_date === day
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={picked}
      onClick={() => onPick(item, day)}
      title={t(picked ? 'console.boardPickedTodayHint' : 'console.boardPickHint')}
    >
      <Icon name="pin" size={12} />
      {picked ? t('console.boardPickedToday') : t('console.boardPickToday')}
    </Button>
  )
}
