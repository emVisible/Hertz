/**
 * 看板页（v0.4 C2 起家的这一页；v0.34 D-218 收成两个栏目）。
 * 数据全部来自既有端点，前端聚合展示，无新后端读模型。
 *
 * 栏目按「问题的种类」分：
 * - 今天（默认，进来就是这页）：今天要做什么、做到哪了——目标清单（一行一条、点了就勾）
 *   + 今日条目 + 今日已发 + 供给水位/洞察
 * - 成本与健康：这段时间做得怎样、花了多少、哪儿在坏
 *
 * 「待处理」不再在这页上（D-218）：捞入今日与单条发布搬去流水线，看板只留今天要动的东西。
 * 这一页写两件事：**勾选当日目标**（`PUT /goal/{day}`，见 `TodayPanel`）与条目的今日关注
 * （`p.setFocus`，唯一作者在 `usePipelineActions`）。目标**文字**仍不在这里改——
 * 那是设置页的「每日目标」那一节（用户：「看板只是显示了，他不做设置」）。
 */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams } from 'react-router-dom'

import { TabBar } from '../../components/ui'
import { goUnscoredPatch } from '../../core/boardWindow'
import { usePipelineExecution } from '../../hooks/usePipelineExecution'
import { useExecutionStore } from '../../stores/execution'
import { HealthPanel } from './HealthPanel'
import { SupplySection } from './SupplySection'
import { TodayPanel } from './TodayPanel'

const SECTION_IDS = ['today', 'health'] as const
type SectionId = (typeof SECTION_IDS)[number]

/** 栏目清单——tab 标签与 `?tab=` 深链白名单同一份，改一处两边跟随。 */
const SECTIONS: Array<{ id: SectionId; labelKey: string }> = [
  { id: 'today', labelKey: 'dashboard.sectionToday' },
  { id: 'health', labelKey: 'dashboard.sectionHealth' },
]

export function DashboardPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  /** 动作面（发布 / 审核 / 今日关注）复用流水线那个总线 hook：查询键与 `usePipelineData`
   *  完全相同（同一份缓存，不多开一路轮询），`setFocus` 的失效也在同一处。 */
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
          <>
            <TodayPanel p={pipeline} onGoUnscored={goUnscored} onGoGoal={goGoal} />
            <SupplySection />
          </>
        )}
        {sectionId === 'health' && <HealthPanel />}
      </div>
    </div>
  )
}
