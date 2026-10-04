/** tab 结构守卫（v0.34）：看板在**顶级菜单**那一页，流水线自己只剩 5 个子 tab。
 *
 * 这些规则都来自用户亲口纠正，不是审美偏好：
 * ① 需求是「融合」而不是「加东西」——同级项不许上升（先是 6→6 把发布 tab 换掉，
 *    后来整体搬到顶级页，流水线降到 5）；
 * ② 他说的「看板」从来指导航栏那一页（进软件默认落到的 `/dashboard`），
 *    所以看板必须挂在那一页上，而不是藏在流水线的子菜单里；
 * ③ 看板只显示、不做设置——写每日目标的位置是「设置 → 每日目标」（D-217）。
 * 双向钉：只测「流水线里没有 board」会奖励搬错地方——所以同时测「dashboard 真挂了它」。
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { PIPELINE_TABS } from './shared'
import { goUnscoredPatch } from '../../../core/boardWindow'
import { useExecutionStore } from '../../../stores/execution'

const SRC = resolve(process.cwd(), 'src')
const read = (rel: string) => readFileSync(resolve(SRC, rel), 'utf-8')

describe('流水线子菜单与看板归属', () => {
  it('流水线只剩 5 个子 tab，board 不在其中', () => {
    expect(PIPELINE_TABS.map((tb) => tb.id)).toEqual([
      'run',
      'workshop',
      'preReview',
      'inReview',
      'exceptions',
    ])
  })

  it('原发布 tab 不回潮（postReview 这个 id 彻底不存在）', () => {
    const ids = PIPELINE_TABS.map((tb) => tb.id as string)
    expect(ids).not.toContain('postReview')
    expect(ids).not.toContain('board')
  })

  it('看板挂在顶级「看板」页上（搬错地方同样算失败）', () => {
    const dash = read('pages/dashboard/DashboardPage.tsx')
    expect(dash).toContain('<TodayPanel')
    expect(existsSync(resolve(SRC, 'pages/dashboard/TodayPanel.tsx'))).toBe(true)
    // 反向：流水线的壳里不该再留任何渲染分支
    expect(read('pages/execution/PipelineView.tsx')).not.toContain('BoardTab')
    expect(read('pages/execution/PipelineView.tsx')).not.toContain('TodayPanel')
  })

  it('看板收成两个栏目：今天（含供给）｜成本与健康', () => {
    const dash = read('pages/dashboard/DashboardPage.tsx')
    expect(dash).toContain('dashboard.sectionToday')
    expect(dash).toContain('dashboard.sectionHealth')
    // 供给不再是第三个栏目（D-218），也不能退回独立文件的旧形状
    expect(dash).not.toContain('dashboard.sectionSupply')
    expect(dash).toContain('<SupplySection')
  })

  it('看板只显示不设置：没有可编辑目标文字的控件，勾选才是它唯一的目标写点', () => {
    // 用户原话：「这个看板只是显示了，他不做设置」+「我每天能设置是否完成，点击一下我就完成了」。
    // 所以形状是：不许有 textarea（改文字去设置），但允许把勾选写回同一行文本。
    // 对照组的另一头在设置那一侧——那条必须真出现 textarea，否则零命中只说明我搜错了形状。
    for (const rel of [
      'pages/dashboard/DashboardPage.tsx',
      'pages/dashboard/TodayPanel.tsx',
      'pages/dashboard/SupplySection.tsx',
      'pages/dashboard/HealthPanel.tsx',
      'pages/dashboard/shared.tsx',
    ]) {
      expect(read(rel), `${rel} 还在看板上编辑目标文字`).not.toContain('<textarea')
    }
    expect(read('pages/settings/sections/GoalSection.tsx')).toContain('<textarea')
    // 勾选这件事只有看板有：设置那一节不许长出 checkbox
    expect(read('pages/dashboard/TodayPanel.tsx')).toContain('type="checkbox"')
    expect(read('pages/settings/sections/GoalSection.tsx')).not.toContain('type="checkbox"')
  })

  it('待处理两列不在看板上，单条发布与捞入今日真的落在了流水线', () => {
    // 「撤视图不撤能力」这条又用上了：D-218 删掉看板的待处理列时，approved 条目在
    // 整个界面里就没有落点了（D-213 把发布 tab 并进看板之后就是这样），所以入口必须
    // 在流水线那一侧真存在——只测「看板里没有了」会奖励删干净但把能力删没。
    for (const rel of [
      'pages/dashboard/DashboardPage.tsx',
      'pages/dashboard/TodayPanel.tsx',
      'pages/dashboard/SupplySection.tsx',
      'pages/dashboard/HealthPanel.tsx',
    ]) {
      expect(read(rel), `${rel} 还挂着待发布那两列`).not.toContain('ready_to_publish')
    }
    const audit = read('pages/execution/pipeline/InReviewTab.tsx')
    expect(audit).toContain('stageApproved')
    expect(audit).toContain('PublishCard')
    // 捞入今日：预处理 + 审核两侧都挂，且都走 `p.setFocus` 那一个写点
    expect(read('pages/execution/pipeline/PreReviewTab.tsx')).toContain('TodayPick')
    expect(audit).toContain('TodayPick')
    expect(read('pages/dashboard/TodayPanel.tsx')).toContain('p.setFocus')
    expect(read('components/execution/TodayPick.tsx')).toContain('focus_date')
  })

  it('流水线默认落在「预处理」（看板已不在流水线里）', () => {
    expect(useExecutionStore.getState().pipeline.tab).toBe('preReview')
  })

  it('跨页动线一次改齐四件事：两轴 + 分段 + tab', () => {
    // 上一版只设了两轴，用户跳过去落在「已下载未加工」——筛选条压根不渲染。
    expect(goUnscoredPatch()).toEqual({
      preTheme: 'sentiment',
      preHasText: 'yes',
      preStage: 'discovered',
      tab: 'preReview',
    })
    // 分段状态必须在 store 里：页面 local state 跨不过去
    expect('preStage' in useExecutionStore.getState().pipeline).toBe(true)
  })

  it('被撤掉的四个视图文件不会自己回来', () => {
    for (const rel of [
      'pages/execution/CalendarView.tsx',
      'pages/execution/calendar.ts',
      'components/execution/QueueView.tsx',
      'pages/execution/pipeline/PostReviewTab.tsx',
      'pages/execution/pipeline/BoardTab.tsx',
      'pages/dashboard/BoardTab.tsx',
      'pages/dashboard/SupplyPanel.tsx',
    ]) {
      expect(existsSync(resolve(SRC, rel))).toBe(false)
    }
  })
})
