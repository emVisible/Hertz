/** tab 结构守卫（v0.34 B）：这次是**融合**，不是加东西。
 *
 * 用户在抱怨「队列/日历结构没用」的同时要了看板。加一级 tab 会变成 7 个并列项——
 * 恰好在被抱怨的地方加东西。所以验收判据就是「同级项不升」，这一条先钉死；
 * 顺手钉两件同轮的既成事实：默认页签、以及被看板上收的两个视图不会自己回来。
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { PIPELINE_TABS } from './shared'
import { useExecutionStore } from '../../../stores/execution'

describe('流水线 tab 结构', () => {
  it('数量仍是 6（看板替换发布，不是加在旁边）', () => {
    expect(PIPELINE_TABS).toHaveLength(6)
    expect(PIPELINE_TABS.map((tb) => tb.id)).toEqual([
      'run',
      'board',
      'workshop',
      'preReview',
      'inReview',
      'exceptions',
    ])
  })

  it('postReview 这个 id 不再存在，且看板带上了原发布 tab 的计数口径', () => {
    const ids = PIPELINE_TABS.map((tb) => tb.id as string)
    expect(ids).not.toContain('postReview')
    const board = PIPELINE_TABS.find((tb) => tb.id === 'board')
    expect(board?.countKeys).toEqual(['approved', 'published'])
  })

  it('默认页签是看板（作者只有 stores/execution 的初始 state）', () => {
    // 读活存储的当前值而不是复制一份常量：jsdom 里 localStorage 是空的，
    // persist 没有可回灌的旧值，拿到的就是 create() 里那份初始 state。
    expect(useExecutionStore.getState().pipeline.tab).toBe('board')
  })

  it('被撤掉的三个视图文件不会自己回来', () => {
    // 正向腿在下面：`board` 那个文件必须真的在——只测「旧文件没了」的守卫，
    // 删掉新界面照样全绿（v0.33 那条「只禁旧形状的守卫」教训）。
    const src = (rel: string) => resolve(process.cwd(), 'src', rel)
    expect(existsSync(src('pages/execution/CalendarView.tsx'))).toBe(false)
    expect(existsSync(src('pages/execution/calendar.ts'))).toBe(false)
    expect(existsSync(src('components/execution/QueueView.tsx'))).toBe(false)
    expect(existsSync(src('pages/execution/pipeline/PostReviewTab.tsx'))).toBe(false)
    expect(existsSync(src('pages/execution/pipeline/BoardTab.tsx'))).toBe(true)
  })
})
