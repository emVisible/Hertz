/** 快捷键（v0.36）——重点测输入框避让，那是最容易伤到用户的地方。
 *
 * 一个把 Delete 判错地方的结果不是「按了没反应」，而是**标题里打不出字**：
 * 用户在标题框按 Delete 却被删掉一个片段，而空格打不出来（变成加入/移出序列）。
 * 这种 bug 没人能靠读代码看出来，只能靠测试钉住。
 */
import { describe, expect, it } from 'vitest'

import { isEditableTarget, TRANSITION_KEY_ORDER } from './useCompilationShortcuts'

describe('isEditableTarget', () => {
  it('input / textarea / select 都要让出键盘', () => {
    const input = document.createElement('input')
    const area = document.createElement('textarea')
    const select = document.createElement('select')
    expect(isEditableTarget(input)).toBe(true)
    expect(isEditableTarget(area)).toBe(true)
    expect(isEditableTarget(select)).toBe(true)
  })

  it('div 等普通元素不是可编辑目标', () => {
    expect(isEditableTarget(document.createElement('div'))).toBe(false)
    expect(isEditableTarget(document.createElement('button'))).toBe(false)
  })

  it('contenteditable 的 div 也要算（否则富文本里打字会触发删片段）', () => {
    const editable = document.createElement('div')
    // jsdom 没实现 isContentEditable（真实浏览器有），这里补上它本该有的值。
    // 不在实现里退化成读 attribute —— 那会造出第二个真相源，只为迁就测试环境。
    Object.defineProperty(editable, 'isContentEditable', { value: true })
    expect(isEditableTarget(editable)).toBe(true)
  })

  it('target 为 null 时安全返回 false', () => {
    // window 级别的按键可能没有 target，此时应当让逻辑正常跑而不是崩
    expect(isEditableTarget(null)).toBe(false)
  })
})

describe('数字键映射', () => {
  it('1…5 的顺序与界面显示顺序一致', () => {
    // 数字键指向的是「用户看不见的枚举顺序」，顺序一旦和下拉框对不上，
    // 按 3 改出来的效果与界面上写的就不一样——用户只能靠试。
    expect(TRANSITION_KEY_ORDER).toEqual(['cut', 'fade', 'wipe', 'dissolve', 'zoomin'])
  })
})