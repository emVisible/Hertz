/** 合集编排的纯逻辑（v0.35）——时长预估、画幅混排、请求体拼装。
 *
 * 这三件事都是「错了界面不报错，但结果错了」的典型，所以单独钉住：
 *
 * 1. **时长预估要扣掉转场重叠**。xfade 让两段画面重叠，总时长因此**变短**。
 *    忘了扣这一项，预估会偏长，且段数越多偏得越多——用户按它判断长度，
 *    判断就是错的。
 * 2. **转场重叠吃的是"前者时长"**。offset = 前段累计 − 转场时长，所以第 N 段
 *    实际新增 (dur[N] − transition[N-1])，而不是 dur[N]。
 * 3. **画幅混排要有预警**。后端 `_resolve_target` 按**首片朝向**输出，混排必然
 *    出黑边；用户按下创建前看不到就等于事后返工。
 * 4. **首段没有入场转场**（服务端也会强制 cut，界面若也发就与存储不一致）。
 */
import { describe, expect, it } from 'vitest'

import type { CompilationSource } from '../api/pipeline'
import {
  buildClips,
  estimateDuration,
  mixedOrientation,
  type GapMap,
} from './useCompilationWorkspace'

function src(
  id: string,
  duration: number | null,
  width: number | null = 320,
  height: number | null = 240,
): CompilationSource {
  return {
    id,
    title: id,
    item_type: 'video_raw',
    raw_path: `/x/${id}.mp4`,
    cover_path: null,
    duration_s: duration,
    width,
    height,
  }
}

function map(rows: CompilationSource[]) {
  return new Map(rows.map((r) => [r.id, r]))
}

const noGaps: GapMap = {}

describe('estimateDuration', () => {
  it('无转场时就是各段相加', () => {
    const s = map([src('a', 10), src('b', 20), src('c', 30)])
    expect(estimateDuration(s, ['a', 'b', 'c'], noGaps)).toBe(60)
  })

  it('每个非硬切间隙扣掉重叠时长', () => {
    // 10+20，两个 0.6s 转场 → 30 - 1.2 = 28.8
    const s = map([src('a', 10), src('b', 20), src('c', 10)])
    const gaps: GapMap = {
      a: { transition: 'fade', seconds: 0.6 },
      b: { transition: 'fade', seconds: 0.6 },
    }
    expect(estimateDuration(s, ['a', 'b', 'c'], gaps)).toBeCloseTo(38.8, 5)
  })

  it('硬切不扣时长（gap 默认就是 cut）', () => {
    const s = map([src('a', 10), src('b', 20)])
    expect(estimateDuration(s, ['a', 'b'], noGaps)).toBe(30)
  })

  it('有段时长未知时返回 null，而不是给一个缺项的假数', () => {
    // 候选接口在文件被清理时会把 duration 置 null。此时给个「看起来对」的
    // 数字比不给更坏——用户会照着它安排。
    const s = map([src('a', 10), src('b', null)])
    expect(estimateDuration(s, ['a', 'b'], noGaps)).toBeNull()
  })

  it('空序列返回 0', () => {
    expect(estimateDuration(map([]), [], noGaps)).toBe(0)
  })
})

describe('mixedOrientation', () => {
  it('全竖屏不算混排（后端会按竖屏输出，全部贴合）', () => {
    const s = map([src('a', 5, 360, 640), src('b', 5, 480, 854)])
    expect(mixedOrientation(s, ['a', 'b'])).toBe(false)
  })

  it('全横屏不算混排', () => {
    const s = map([src('a', 5, 640, 360), src('b', 5, 1280, 720)])
    expect(mixedOrientation(s, ['a', 'b'])).toBe(false)
  })

  it('横竖混排要报出来（后端按首片输出，另一侧必然黑边）', () => {
    const s = map([src('a', 5, 360, 640), src('b', 5, 1280, 720)])
    expect(mixedOrientation(s, ['a', 'b'])).toBe(true)
  })

  it('首片是横屏、后段混入竖屏也算（基准永远是首片）', () => {
    const s = map([src('a', 5, 1280, 720), src('b', 5, 360, 640)])
    expect(mixedOrientation(s, ['a', 'b'])).toBe(true)
  })

  it('画幅未知或不足两段时不下结论', () => {
    expect(mixedOrientation(map([src('a', 5, null, null)]), ['a'])).toBe(false)
    const s = map([src('a', 5, null, null), src('b', 5, 360, 640)])
    expect(mixedOrientation(s, ['a', 'b'])).toBe(false)
    expect(mixedOrientation(map([src('a', 5, 320, 240)]), ['a'])).toBe(false)
  })
})

describe('buildClips', () => {
  it('首段不带 transition（服务端会强制 cut，界面也该一致）', () => {
    const gaps: GapMap = { a: { transition: 'fade', seconds: 0.6 } }
    const clips = buildClips(['a', 'b'], gaps)
    expect(clips[0]).toEqual({ item_id: 'a' })
    expect(clips[0].transition).toBeUndefined()
  })

  it('后续段带英文档名与时长（发中文会被 422）', () => {
    const gaps: GapMap = { a: { transition: 'wipe', seconds: 0.8 } }
    const clips = buildClips(['a', 'b'], gaps)
    expect(clips[1]).toMatchObject({ item_id: 'b', transition: 'wipe', transition_s: 0.8 })
  })

  it('没设过的间隙默认硬切', () => {
    const clips = buildClips(['a', 'b', 'c'], noGaps)
    expect(clips[1].transition).toBe('cut')
    expect(clips[2].transition).toBe('cut')
  })

  it('顺序即数组顺序', () => {
    const clips = buildClips(['c', 'a', 'b'], noGaps)
    expect(clips.map((c) => c.item_id)).toEqual(['c', 'a', 'b'])
  })
})
