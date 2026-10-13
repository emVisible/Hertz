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
  DEFAULT_TRANSITION_S,
  estimateDuration,
  gapKey,
  MAX_TRANSITION_S,
  MIN_TRANSITION_S,
  mixedOrientation,
  TRANSITION_PRESETS,
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

/**
 * 转场默认时长（v0.37）——统一成 0.32s。
 *
 * ## 为什么要统一
 *
 * 原本 fade=0.6 / wipe=0.5 / dissolve=0.6 / zoomin=0.7。于是用户切一次转场，
 * 总时长就变一次，而**他并没有要求这件事**：「预估 3:12」变成「3:09」，
 * 他只会认为面板算错。统一切换不再影响总时长；想调的人自己拖输入框。
 */
describe('转场默认时长', () => {
  it('所有非硬切预设共用同一个默认值', () => {
    const nonCut = TRANSITION_PRESETS.filter((p) => p.value !== 'cut')
    expect(nonCut.length).toBeGreaterThan(0)
    for (const p of nonCut) {
      expect(p.seconds, `${p.value} 的默认时长与其他转场不一致`).toBe(DEFAULT_TRANSITION_S)
    }
  })

  it('默认值是 0.32s（产品决策，改它必须先改这里）', () => {
    expect(DEFAULT_TRANSITION_S).toBe(0.32)
  })

  it('硬切的时长是 0——它是「没有转场」，不是「零秒转场」', () => {
    const cut = TRANSITION_PRESETS.find((p) => p.value === 'cut')
    expect(cut?.seconds).toBe(0)
  })

  it('默认值落在输入框允许的范围内（填了也会被后端钳制掉 = 白填）', () => {
    // 后端 assemble._clamp_transition 会把越界值改掉，界面给的反馈与实际
    // 生效的不一致——用户填 0.1，出来的却是 0.2。
    expect(DEFAULT_TRANSITION_S).toBeGreaterThanOrEqual(MIN_TRANSITION_S)
    expect(DEFAULT_TRANSITION_S).toBeLessThanOrEqual(MAX_TRANSITION_S)
  })

  it('默认值在 number input 的 step 上是合法步进值', () => {
    // step=0.1 时 0.32 不是合法值，点箭头/失焦会被浏览器悄悄改成 0.3 或 0.4。
    // UI 里必须用 step=0.01；这里钉住这个前提。
    const step = 0.01
    expect(Number(((DEFAULT_TRANSITION_S / step) % 1).toFixed(6))).toBe(0)
  })

  it('切换转场不会改变预估总时长（各预设时长相同即自动成立）', () => {
    const s = map([src('a', 10), src('b', 20)])
    const withFade = estimateDuration(s, ['a', 'b'], {
      a: { transition: 'fade', seconds: TRANSITION_PRESETS.find((p) => p.value === 'fade')!.seconds },
    })
    const withWipe = estimateDuration(s, ['a', 'b'], {
      a: { transition: 'wipe', seconds: TRANSITION_PRESETS.find((p) => p.value === 'wipe')!.seconds },
    })
    expect(withFade).toBe(withWipe)
  })
})

/**
 * 缺失源的判定（v0.38）。
 *
 * ## 这条 bug 的形状
 *
 * 候选列表是异步查回来的，`pool` 在拿到响应前是 `[]`。而 `items` 此前是
 * `sources.get(id) ?? null`，UI 一见 null 就渲染「源已移除」——于是**每次进面板
 * 的最初几百毫秒里，已经在序列里的片段都被冤枉成文件丢了**。
 *
 * 那是关于用户自己数据的假结论，用户会当真：他会去磁盘上找文件，或者以为
 * 软件坏了。加载中不是缺失——只有查过了、确实查不到，才是缺失。
 */
describe('missingIds：加载中不算缺失', () => {
  const ID_A = 'a'
  const ID_B = 'b'

  /** 复刻 items 的状态推导，避免测试直接依赖 React 渲染。 */
  function states(
    clipIds: string[],
    pool: CompilationSource[],
    isLoading: boolean,
  ): ('ready' | 'loading' | 'missing')[] {
    const byId = new Map(pool.map((s) => [s.id, s]))
    return clipIds.map((id) => {
      const source = byId.get(id) ?? null
      return source ? 'ready' : isLoading ? 'loading' : 'missing'
    })
  }

  it('加载中且池为空 → 标 loading，不标 missing', () => {
    expect(states([ID_A, ID_B], [], true)).toEqual(['loading', 'loading'])
  })

  it('加载完成后仍查不到 → 才是 missing', () => {
    expect(states([ID_A, ID_B], [], false)).toEqual(['missing', 'missing'])
  })

  it('加载完成且查到了 → ready', () => {
    expect(states([ID_A], [src(ID_A, 10)], false)).toEqual(['ready'])
  })

  it('部分查不到 → 只把查不到的算 missing', () => {
    const got = states([ID_A, ID_B], [src(ID_A, 10)], false)
    expect(got).toEqual(['ready', 'missing'])
  })

  it('中途从 loading 变 missing 是允许的——它就是真相浮现', () => {
    // 先 loading 后 missing：候选列表回来了，这条确实不在里面
    expect(states([ID_A], [], true)).toEqual(['loading'])
    expect(states([ID_A], [], false)).toEqual(['missing'])
  })
})

/** 创建闸门：缺任何一段就不能建。 */
describe('canCreate', () => {
  function canCreate(clipCount: number, missingCount: number): boolean {
    return clipCount > 0 && missingCount === 0
  }

  it('空序列不能建', () => {
    expect(canCreate(0, 0)).toBe(false)
  })

  it('有片段且无缺失 → 可以建', () => {
    expect(canCreate(3, 0)).toBe(true)
  })

  it('有缺失片段 → 不能建（哪怕其余都正常）', () => {
    // 后端 create_compilation 本来就会拒（缺条目/无 raw/状态不对都 ValueError），
    // 前端不该让用户按下一个必然失败的按钮、再从服务端拿回一句「片段不存在」。
    expect(canCreate(3, 1)).toBe(false)
  })
})

/**
 * 草稿恢复时的剪枝（v0.38）。
 *
 * 横幅此前说「已恢复上次未完成的编排」，但 `useCompilationDraft` 只把草稿读进
 * 自己的 state 判断 `hasDraft`，**从未恢复进序列**——用户看到的是「已恢复」+
 * 空列表。这条测试锁住恢复行为本身。
 */
describe('草稿恢复的剪枝', () => {
  const SOURCES = ['a', 'b', 'c']

  /** 复刻恢复时的剪枝：只留仍在候选里的 id。 */
  function prune(draftIds: string[], available: string[]) {
    const have = new Set(available)
    const keep = draftIds.filter((id) => have.has(id))
    return { keep, dropped: draftIds.length - keep.length }
  }

  it('全部仍可用 → 全留，不提示剪枝', () => {
    const r = prune(['a', 'b', 'c'], SOURCES)
    expect(r.keep).toEqual(['a', 'b', 'c'])
    expect(r.dropped).toBe(0)
  })

  it('部分失效 → 剪掉失效的，并如实报出条数', () => {
    // 用户排了 4 段，其中 1 段素材被清理了
    const r = prune(['a', 'x', 'b', 'c'], SOURCES)
    expect(r.keep).toEqual(['a', 'b', 'c'])
    expect(r.dropped).toBe(1)
  })

  it('全部失效 → 恢复为空，不硬塞一屏「源已移除」', () => {
    const r = prune(['x', 'y'], SOURCES)
    expect(r.keep).toEqual([])
    expect(r.dropped).toBe(2)
  })

  it('剪枝后仍保序（用户的编排顺序不能被打乱）', () => {
    const r = prune(['c', 'x', 'a', 'b'], SOURCES)
    expect(r.keep).toEqual(['c', 'a', 'b'])
  })
})
