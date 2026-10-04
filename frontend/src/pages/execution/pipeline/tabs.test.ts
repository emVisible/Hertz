/** tab 结构守卫（v0.34）：看板在**顶级菜单**那一页，流水线自己只剩 5 个子 tab。
 *
 * 两条规则都来自用户亲口纠正，不是审美偏好：
 * ① 需求是「融合」而不是「加东西」——同级项不许上升（先是 6→6 把发布 tab 换掉，
 *    后来整体搬到顶级页，流水线降到 5）；
 * ② 他说的「看板」从来指导航栏那一页（进软件默认落到的 `/dashboard`），
 *    所以看板必须挂在那一页上，而不是藏在流水线的子菜单里。
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
    expect(dash).toContain('<BoardTab')
    expect(existsSync(resolve(SRC, 'pages/dashboard/BoardTab.tsx'))).toBe(true)
    // 反向：流水线的壳里不该再留任何渲染分支
    expect(read('pages/execution/PipelineView.tsx')).not.toContain('BoardTab')
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
    ]) {
      expect(existsSync(resolve(SRC, rel))).toBe(false)
    }
  })
})
