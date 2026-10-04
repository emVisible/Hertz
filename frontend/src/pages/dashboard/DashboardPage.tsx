/**
 * 看板页（v0.4 C2 起家的这一页；v0.34 D-219 收成「读数 + 右侧悬浮待办」）。
 * 数据全部来自既有端点，前端聚合展示，无新后端读模型。
 *
 * 两个栏目：
 * - 今天（默认）：主区只有**供给水位**（趋势 + 各阶段存量，外加频道洞察），
 *   右侧常驻一块**悬浮的「今日待办」**——目标清单（一行一条、点了就勾）+ 一个最简指标
 *   「今日已发 N」。条目列表与今日已发那排 chip 已按用户要求删掉（D-219），
 *   做事的入口在流水线（D-218：单条发布 + 捞入今日）。
 * - 成本与健康：这段时间做得怎样、花了多少、哪儿在坏。
 *
 * 这一页**不再需要流水线那包动作**（`usePipelineExecution`）：看板上一个条目动作都不发了，
 * 唯一的写动作是勾选目标，走 `PUT /goal/{day}`。目标**文字**仍在「设置 → 每日目标」里改。
 */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams } from 'react-router-dom'

import { TabBar } from '../../components/ui'
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

  const [searchParams] = useSearchParams()
  const [sectionId, setSectionId] = useState<SectionId>('today')
  // 同路由重复导航不重挂载 → 用 effect 响应参数变化（照设置页 `?section=` 的先例）
  useEffect(() => {
    const tab = searchParams.get('tab')
    if (tab && (SECTION_IDS as readonly string[]).includes(tab)) setSectionId(tab as SectionId)
  }, [searchParams])

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-6">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
        <div className="flex flex-wrap items-center gap-4">
          <h1 className="text-base font-semibold text-text-primary">{t('dashboard.title')}</h1>
          <TabBar
            items={SECTIONS.map((s) => ({ id: s.id, label: t(s.labelKey) }))}
            active={sectionId}
            onChange={setSectionId}
          />
        </div>

        {sectionId === 'today' && (
          <div className="flex flex-col items-start gap-4 lg:flex-row">
            <div className="min-w-0 flex-1">
              <SupplySection />
            </div>
            {/* 悬浮：跟着这一页的滚动容器钉在右上，清单长了自己滚（不跟着整页跑掉） */}
            <aside className="w-full shrink-0 lg:sticky lg:top-0 lg:w-80">
              <TodayPanel onGoGoal={() => navigate('/config?section=goal')} />
            </aside>
          </div>
        )}
        {sectionId === 'health' && <HealthPanel />}
      </div>
    </div>
  )
}
