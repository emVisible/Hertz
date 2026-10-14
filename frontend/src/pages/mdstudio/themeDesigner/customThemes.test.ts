/** 自建主题存储的判据（Phase 3）。
 *
 * 这片最危险的失败模式不是崩，而是**静默丢数据**：用户存了 5 套主题，其中一套
 * JSON 坏了，结果整份存储被清空。所以「坏一条只丢那一条」是这里的头号判据。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { clearCustomThemes, getTheme, listCustomThemes } from '@hertz/mdcore'

import {
  currentValue,
  deleteCustomTheme,
  exportThemes,
  hydrateCustomThemes,
  importThemes,
  normalizeThemeId,
  saveCustomTheme,
} from './customThemes'

function entry(id: string, patch: Record<string, unknown> = {}) {
  const base = getTheme('modi')
  return {
    id,
    name: id.replace('user:', ''),
    platform: 'wechat' as const,
    tokens: { ...base.tokens, ...patch },
  }
}

beforeEach(() => {
  localStorage.clear()
  clearCustomThemes()
})

describe('id 规范化', () => {
  it('自动补 user: 前缀并清掉危险字符', () => {
    expect(normalizeThemeId('我的 主题/测试')).toBe('user:我的-主题-测试')
    expect(normalizeThemeId('user:already')).toBe('user:already')
  })

  it('撞内置名就加后缀（用户想把「墨滴」存成自己的主题是合法意图）', () => {
    expect(normalizeThemeId('modi')).toBe('user:modi-1')
  })

  it('空名字兜底成 user:theme', () => {
    expect(normalizeThemeId('   ')).toBe('user:theme')
  })
})

describe('保存与载入', () => {
  it('另存为我的主题：进注册表 + 进 localStorage，重开应用还在', () => {
    saveCustomTheme(entry('user:ink-a'))
    expect(listCustomThemes().map((t) => t.id)).toEqual(['user:ink-a'])

    clearCustomThemes() // 模拟刷新：注册表空了
    expect(hydrateCustomThemes()).toBe(1);
    expect(listCustomThemes().map((t) => t.id)).toEqual(['user:ink-a']);
  })

  it('同名保存是覆盖，不是堆第二份', () => {
    saveCustomTheme(entry('user:ink-a'))
    saveCustomTheme({ ...entry('user:ink-a'), name: '改过的名' })
    expect(listCustomThemes()).toHaveLength(1);
    expect(getTheme('user:ink-a').name).toBe('改过的名');
  })

  it('删除只删目标那套', () => {
    saveCustomTheme(entry('user:ink-a'))
    saveCustomTheme(entry('user:ink-b'))
    deleteCustomTheme('user:ink-a')
    expect(listCustomThemes().map((t) => t.id)).toEqual(['user:ink-b'])
  })
})

describe('脏数据不许连坐', () => {
  it('存了 5 套、坏 1 套 → 另外 4 套全在', () => {
    const key = 'hertz.mdstudio.themes.v1'
    const good = [entry('user:a'), entry('user:b'), entry('user:c'), entry('user:d'), entry('user:e')];
    const broken = { id: 'user:bad', name: '坏的', platform: 'wechat', tokens: { color: '#fff' } }
    localStorage.setItem(key, JSON.stringify([...good, broken]))

    expect(hydrateCustomThemes()).toBe(5)
    expect(listCustomThemes()).toHaveLength(5)
  })

  it('整个存储是垃圾时不抛（退化成零套自建主题）', () => {
    localStorage.setItem('hertz.mdstudio.themes.v1', '{ not json')
    expect(hydrateCustomThemes()).toBe(0)
  })

  it('不认识的平台退到 generic，不丢主题', () => {
    localStorage.setItem(
      'hertz.mdstudio.themes.v1',
      JSON.stringify([{ ...entry('user:x'), platform: 'douyin' }]),
    )
    expect(hydrateCustomThemes()).toBe(1)
    expect(getTheme('user:x').platform).toBe('generic')
  })
})

describe('导入导出', () => {
  it('导出 → 导入（清空后）能原样回来', () => {
    saveCustomTheme(entry('user:ink-a', { color: '#123456' }))
    const json = exportThemes()
    deleteCustomTheme('user:ink-a')
    expect(listCustomThemes()).toHaveLength(0)

    expect(importThemes(json, { replace: true })).toBe(1)
    expect(getTheme('user:ink-a').tokens.color).toBe('#123456')
  })

  it('导出的 JSON 带 schema 版本（将来能迁移）', () => {
    saveCustomTheme(entry('user:ink-a'))
    const parsed = JSON.parse(exportThemes()) as { schema: string; version: number }
    expect(parsed.schema).toBe('hertz.mdstudio.themes')
    expect(parsed.version).toBe(1)
  })

  it('不合法文件响亮失败，不半途写坏存储', () => {
    expect(() => importThemes('{"themes": "不是数组"}')).toThrow(/主题数组/)
    expect(() => importThemes(JSON.stringify([{ tokens: {} }]))).toThrow(/必填 token/)
    expect(listCustomThemes()).toHaveLength(0)
  })

  it('导出可只挑几套（分享单套用）', () => {
    saveCustomTheme(entry('user:a'))
    saveCustomTheme(entry('user:b'))
    const parsed = JSON.parse(exportThemes(['user:a'])) as { themes: unknown[] }
    expect(parsed.themes).toHaveLength(1)
  })
})

describe('当前值解析', () => {
  it('overrides 优先，没有的取主题解析值', () => {
    const theme = getTheme('modi')
    const value = currentValue(theme, { fontSize: '19px' }, 'fontSize')
    expect(value).toBe('19px')
    expect(currentValue(theme, {}, 'fontSize')).toBe(theme.tokens.fontSize)
  })

  it('派生项在没 override 时确实是跟着主色算的（设计器的"跟随主色"徽标要成立）', () => {
    const theme = getTheme('modi')
    const softDefault = currentValue(theme, {}, 'soft')
    const softChanged = currentValue(theme, { color: '#ff0000' }, 'soft')
    expect(softChanged).not.toBe(softDefault)
  })
})