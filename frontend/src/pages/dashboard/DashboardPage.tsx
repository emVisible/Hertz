/**
 * 看板页（v0.4 C2 起家的这一页；v0.34 重设计拆成三个栏目）。
 * 数据全部来自既有端点，前端聚合展示，无新后端读模型。
 *
 * 三个栏目按「问题的种类」分，不按数据来源分：
 * - 今天：今天要动哪几条（目标 + 待办 + 今日已发），**一块**，可动手
 * - 供给：手里还有多少货、该捞什么口味
 * - 成本与健康：这段时间做得怎样、花了多少、哪儿在坏
 * 原来 15 个模块平铺一屏，滚不到底也看不出该先看哪儿（D-217）。
 *
 * 这一页只写两件事：`focus_date`/`focus_note`（捞进/移出今日）与条目的阶段动作。
 * **每日目标不在这里编辑**——用户定的是「看板只显示，不做设置」，写目标的地方是
 * 顶级「设置 → 每日目标」（`pages/settings/sections/GoalSection.tsx`）。
 */

import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams } from 'react-router-dom'

import { pipelineApi, type PipelineItem } from '../../api'
import { TabBar } from '../../components/ui'
import { goUnscoredPatch } from '../../core/boardWindow'
import { usePipelineExecution } from '../../hooks/usePipelineExecution'
import { useExecutionStore } from '../../stores/execution'
import { HealthPanel } from './HealthPanel'
import { SupplyPanel } from './SupplyPanel'
import { TodayPanel, type FocusPatch } from './TodayPanel'

const SECTION_IDS = ['today', 'supply', 'health'] as const
type SectionId = (typeof SECTION_IDS)[number]

/** 栏目清单——tab 标签与 `?tab=` 深链白名单同一份，改一处两边跟随。 */
const SECTIONS: Array<{ id: SectionId; labelKey: string }> = [
  { id: 'today', labelKey: 'dashboard.sectionToday' },
  { id: 'supply', labelKey: 'dashboard.sectionSupply' },
  { id: 'health', labelKey: 'dashboard.sectionHealth' },
]

export function DashboardPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const qc = useQueryClient()
  /** 动作面（发布/审核/捞入）复用流水线那个总线 hook：查询键与 `usePipelineData`
   *  完全相同（同一份缓存，不会多一套轮询），组件也是同一批——全仓一套发布入口。 */
  const pipeline = usePipelineExecution()

  const [searchParams] = useSearchParams()
  const [sectionId, setSectionId] = useState<SectionId>('today')
  // 同路由重复导航不重挂载 → 用 effect 响应参数变化（照设置页 `?section=` 的先例）
  useEffect(() => {
    const tab = searchParams.get('tab')
    if (tab && (SECTION_IDS as readonly string[]).includes(tab)) setSectionId(tab as SectionId)
  }, [searchParams])

  const goUnscored = () => {
    // 四件事一次设齐（轴 ×2 + 分段 + tab）再跳过去——分开写就会漏掉分段那条，
    // 漏了就落在「已下载未加工」上，筛选条不渲染（判据在 `goUnscoredPatch` 的测试里）。
    useExecutionStore.getState().setPipeline(goUnscoredPatch())
    navigate('/execution?mode=pipeline')
  }
  const goGoal = () => navigate('/config?section=goal')

  /** 今日关注的写点只有一个：两个栏目都要捞入/移出，失效也只需一处。
   *  日期归各面板自己管（今天栏可回看昨天，供给栏只对着当天）。 */
  const focusMut = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: FocusPatch }) => pipelineApi.setFocus(id, patch),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['pipeline-board'] }),
  })
  const onFocus = (item: PipelineItem, patch: FocusPatch) => focusMut.mutate({ id: item.id, patch })

  const actions = { p: pipeline, onFocus }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-6">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
        <div className="flex flex-wrap items-center gap-4">
          <h1 className="text-base font-semibold text-text-primary">{t('dashboard.title')}</h1>
          <TabBar
            items={SECTIONS.map((s) => ({ id: s.id, label: t(s.labelKey) }))}
            active={sectionId}
            onChange={setSectionId}
          />
        </div>

        {sectionId === 'today' && (
          <TodayPanel p={pipeline} onFocus={onFocus} onGoUnscored={goUnscored} onGoGoal={goGoal} />
        )}
        {sectionId === 'supply' && <SupplyPanel {...actions} />}
        {sectionId === 'health' && <HealthPanel />}
      </div>
    </div>
  )
}
