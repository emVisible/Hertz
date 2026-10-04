/** 设置分区清单的**单一作者**守卫（v0.34 看板重设计时顺手收的）。
 *
 * 为什么现在补：左栏导航、`?section=` 深链白名单、⌘K 命令面板从前各写一份字面量，
 * 已经漂过一次——`norms` 进了左栏导航却没进面板，于是「面板里能跳的分区」和
 * 「设置页真实存在的分区」成了两个答案，而漂移不报错（两边类型都对）。
 * 加「每日目标」这一节正是第三次会漏同步的地方。
 *
 * 判据的对照组在第二条：同一条 matcher 必须在清单本体上命中，否则那两处「零命中」
 * 只说明我搜错了形状（空结果≠不存在，这条在本仓坑过两次）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { SETTINGS_SECTIONS } from './SettingsNav'

const SRC = resolve(process.cwd(), 'src')
const read = (rel: string) => {
  const path = resolve(SRC, rel)
  if (!existsSync(path)) throw new Error(`文件不在预期位置：${rel}`)
  return readFileSync(path, 'utf-8')
}

/** 一份目录里的 `settings.*` 键集合（已剥掉命名空间前缀，比对时用 `labelKey` 的后半）。 */
function settingKeys(lang: 'zh' | 'en'): Set<string> {
  const doc = JSON.parse(read(`i18n/${lang}.json`)) as { settings: Record<string, unknown> }
  return new Set(Object.keys(doc.settings).map((k) => `settings.${k}`))
}

describe('设置分区清单', () => {
  it('id 唯一、包含「每日目标」，每个 labelKey 在两份目录里都在', () => {
    const ids = SETTINGS_SECTIONS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain('goal')
    const zh = settingKeys('zh')
    const en = settingKeys('en')
    const missing = SETTINGS_SECTIONS.filter((s) => !zh.has(s.labelKey) || !en.has(s.labelKey)).map((s) => s.labelKey)
    expect(missing, `这些分区标签没有 i18n 键：${missing.join(', ')}`).toEqual([])
  })

  it('导航、深链白名单、⌘K 面板三处都读同一份清单', () => {
    // 正向：两处消费者必须引用那个符号（引用了就不会再各写一份）
    const page = read('pages/settings/SettingsPage.tsx')
    const palette = read('components/CommandPalette.tsx')
    expect(page).toContain('SETTINGS_SECTIONS')
    expect(palette).toContain('SETTINGS_SECTIONS')
    // 反向：两处都不许再留自己的字面量清单。对照组证明这条 matcher 真的抓得到——
    // 清单本体（SettingsNav）用的正是这个形状。
    const literal = "{ id: 'general',"
    expect(read('pages/settings/SettingsNav.tsx')).toContain(literal)
    expect(page).not.toContain(literal)
    expect(palette).not.toContain(literal)
  })

  it('「每日目标」这一节真的渲染出编辑目标的那个组件', () => {
    // 光有导航项而没渲染分支是这一片最容易出现的半截状态（点了没反应）。
    const page = read('pages/settings/SettingsPage.tsx')
    expect(page).toContain("<GoalSection")
    expect(existsSync(resolve(SRC, 'pages/settings/sections/GoalSection.tsx'))).toBe(true)
  })
})
