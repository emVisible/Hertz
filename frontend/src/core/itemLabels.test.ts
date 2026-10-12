/** 条目枚举 → i18n key（v0.35）——`core/itemLabels`。
 *
 * 存在的理由是「中文界面里混着英文枚举」：仓库曾有 10 处直接渲染
 * `{item.status}` / `{item.item_type}`，于是 `downloaded`、`video_raw`
 * 原样出现在中文界面上。词条其实早就齐了，缺的只是取词那一步。
 *
 * 这里钉两件事：
 * 1. **覆盖完整**：8 个状态 + 3 个类型每一个都必须有词条。少一个就是某天
 *    界面上又冒出英文，而且往往要等用户截图才发现。
 * 2. **未知值不吐英文**：这是本次修复的要点——回落必须是我们自己的
 *    「未知状态」键，而不是 `status` 原值。否则新加一个状态枚举时，
 *    这里会静默退回到「显示英文」的老毛病。
 */
import { describe, expect, it } from 'vitest'

import { hasStatusLabel, itemStatusKey, itemTypeKey } from './itemLabels'

const ALL_STATUSES = [
  'discovered',
  'scored',
  'downloaded',
  'queued',
  'approved',
  'published',
  'rejected',
  'failed',
] as const

const ALL_TYPES = ['video_raw', 'image_gallery', 'text_only'] as const

describe('itemLabels', () => {
  it('8 个状态全部有词条，且互不重复', () => {
    const keys = ALL_STATUSES.map(itemStatusKey)
    for (const status of ALL_STATUSES) {
      expect(keys).toContain(`console.${status}`)
    }
    expect(new Set(keys).size).toBe(ALL_STATUSES.length)
  })

  it('3 个素材类型全部有词条', () => {
    expect(ALL_TYPES.map(itemTypeKey)).toEqual([
      'console.typeVideo',
      'console.typeImage',
      'console.typeText',
    ])
  })

  it('未知状态/类型回落到「未知」而不是英文原值', () => {
    // 关键断言：回落键**不是**入参本身——那等于没修。
    expect(itemStatusKey('brand_new_status')).toBe('console.unknownStatus')
    expect(itemTypeKey('brand_new_type')).toBe('console.unknownType')
    for (const bad of [null, undefined, '', 'DOWNLOADED', 'Downloaded']) {
      expect(itemStatusKey(bad)).toBe('console.unknownStatus')
      expect(itemTypeKey(bad)).toBe('console.unknownType')
    }
  })

  it('大小写敏感（枚举是精确小写串，容错反而会掩盖脏数据）', () => {
    // 'Downloaded' 不是合法枚举值。若把它也映射上，等于把拼写错误
    // 悄悄放过——数据层出问题时会一直找不到根因。
    expect(hasStatusLabel('Downloaded')).toBe(false)
    expect(hasStatusLabel('downloaded')).toBe(true)
  })

  it('hasStatusLabel 给出「原样显示」的显式出口', () => {
    // 少数场景（如调试面板）确实要显示原始枚举；这个谓词让那种需求
    // 有路可走，而不是又一处 `{item.status}` 混回来。
    expect(hasStatusLabel('failed')).toBe(true)
    expect(hasStatusLabel(undefined)).toBe(false)
  })
})
