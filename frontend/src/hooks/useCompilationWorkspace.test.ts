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
  gapKey,
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

/**
 * 间隙键一致性（v0.37）——本轮错位 bug 的回归。
 *
 * ## 这个 bug 长什么样
 *
 * 转场下拉框的 `value` 读 `gaps[clipIds[idx-1]]`（这张卡**之前**的间隙），
 * `onChange` 写 `gaps[s.id]`（这张卡**之后**的间隙）。同一个控件读写两个键：
 * 用户改「第 1、2 段之间」的转场，实际改到了「第 2、3 段之间」。
 *
 * 界面不报错、不崩，只是结果悄悄不对——所以只能靠测试钉。
 */
describe('gapKey：间隙的唯一定义', () => {
  const ids = ['a', 'b', 'c', 'd']

  it('第 idx 段的入场转场，键是**前一段**的 id', () => {
    expect(gapKey(ids, 0)).toBeNull()
    expect(gapKey(ids, 1)).toBe('a')
    expect(gapKey(ids, 2)).toBe('b')
    expect(gapKey(ids, 3)).toBe('c')
  })

  it('首段与负下标都返回 null（没有入场转场）', () => {
    expect(gapKey(ids, 0)).toBeNull()
    expect(gapKey(ids, -1)).toBeNull()
  })

  it('空序列恒为 null', () => {
    expect(gapKey([], 0)).toBeNull()
    expect(gapKey([], 5)).toBeNull()
  })

  it('N 段恰好有 N-1 个间隙键（不多不少）', () => {
    for (const n of [1, 2, 5, 30]) {
      const seq = Array.from({ length: n }, (_, i) => `c${i}`)
      const keys = seq.map((_, i) => gapKey(seq, i)).filter((k) => k !== null)
      expect(keys).toHaveLength(Math.max(0, n - 1))
      // 每个键都是序列里真实存在的 id —— 键不能凭空造出来
      expect(new Set(keys).size).toBe(keys.length)
      for (const k of keys) expect(seq).toContain(k as string)
    }
  })
})

describe('buildClips 与 gapKey 同源', () => {
  it('按 gapKey 设的转场，正好落在 buildClips 读的那一段上', () => {
    // 这是本次错位 bug 的等价形式：任何「按 idx 写、按另一套规则读」都会让它失败
    const ids = ['a', 'b', 'c', 'd']
    const gaps: GapMap = {}
    const want = ['fade', 'wipe', 'dissolve'] as const
    ids.forEach((_, idx) => {
      const key = gapKey(ids, idx)
      if (key !== null) gaps[key] = { transition: want[idx - 1], seconds: 0.5 }
    })
    const clips = buildClips(ids, gaps)
    // 第 idx 段的 transition 必须等于「按 gapKey 写进去的那个」
    ids.forEach((_, idx) => {
      const key = gapKey(ids, idx)
      expect(clips[idx].transition).toBe(key === null ? undefined : gaps[key]?.transition)
    })
    expect(clips.map((c) => c.transition)).toEqual([undefined, 'fade', 'wipe', 'dissolve'])
  })

  it('「改第 2 段的入场转场」不会影响第 3 段', () => {
    // 错位 bug 的行为特征：改一处、别处跟着变
    const ids = ['a', 'b', 'c']
    let gaps: GapMap = { a: { transition: 'cut', seconds: 0.6 } }
    const key = gapKey(ids, 1)
    gaps = { ...gaps, [key as string]: { transition: 'fade', seconds: 0.6 } }
    const clips = buildClips(ids, gaps)
    expect(clips[1].transition).toBe('fade')
    expect(clips[2].transition).toBe('cut')
  })
})
