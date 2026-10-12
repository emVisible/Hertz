/** 撤销/重做与草稿（v0.36）——两个最容易「静默丢数据」的地方。
 *
 * ## 为什么这两件事必须有测试
 *
 * 都是「界面不报错，但用户的编排少了一段」的类型：
 *
 * 1. **标题不该进撤销栈的另一半**。title/clipIds/gaps/outro 同属一次排布，
 *    拆开存会各自入栈，于是撤销撤销到一半状态就乱了。
 * 2. **脏草稿不能白屏**。手改 localStorage、旧版本字段、手动写坏 JSON 都得
 *    降级成「没有草稿」，而不是崩掉整个编排。
 * 3. **空编排不该留草稿痕迹**，否则下次打开平白多一条空记录。
 */
import { describe, expect, it, beforeEach } from 'vitest'

import { loadDraft, type DraftState } from './useCompilationDraft'

/** 内存版 Storage——不碰真实 localStorage，避免测试之间互相污染。 */
function memStorage(seed: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(seed))
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  } as Storage
}

const KEY = 'hz.pipeline.compilation.draft.v1'

describe('loadDraft', () => {
  let store: Storage

  beforeEach(() => {
    store = memStorage()
  })

  it('没有草稿返回 null', () => {
    expect(loadDraft(store)).toBeNull()
  })

  it('完整草稿原样读回', () => {
    const d: DraftState = {
      title: '旅行合集',
      clipIds: ['a', 'b'],
      gaps: { a: { transition: 'fade', seconds: 0.6 } },
      outro: true,
    }
    store.setItem(KEY, JSON.stringify(d))
    expect(loadDraft(store)).toEqual(d)
  })

  it('JSON 损坏降级成 null，而不是抛', () => {
    // 手改 localStorage / 写到一半被截断：编排不该因此不可用
    store.setItem(KEY, '{title: "断了一半"')
    expect(loadDraft(store)).toBeNull()
  })

  it('缺字段补默认值（跨版本字段变化）', () => {
    store.setItem(KEY, JSON.stringify({ title: '老版本' }))
    expect(loadDraft(store)).toEqual({ title: '老版本', clipIds: [], gaps: {}, outro: false })
  })

  it('clipIds 里混入非字符串就滤掉', () => {
    store.setItem(KEY, JSON.stringify({ title: 'x', clipIds: ['a', 123, null, 'b'] }))
    expect(loadDraft(store)?.clipIds).toEqual(['a', 'b'])
  })

  it('storage 不存在（隐私模式 / SSR）返回 null，不崩', () => {
    expect(loadDraft(undefined)).toBeNull()
  })
})