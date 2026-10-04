/** 目标清单的纯函数测试（v0.34 D-218）。
 *
 * 这条模块是「一行 = 一条待办 + 勾选状态」的唯一作者，所以判据全在这里测：
 * 界面只负责把它渲染成可点的东西。最关键的是第 2、5 条——**点一次勾不许动别的行**，
 * 因为这段文本是他自己写的字，重写全文等于替他改稿。
 */

import { describe, expect, it } from 'vitest'

import { clearGoalTicks, goalProgress, parseGoalLines, toggleGoalLine } from './goalChecklist'

const THREE = '过一遍 AITA 前 20 条\n挑 5 条改开头\n\n只筛不发做复盘'

describe('goalChecklist', () => {
  it('没写标记的行也是待办，且都不是已完成', () => {
    const lines = parseGoalLines(THREE)
    expect(lines.map((l) => l.content)).toEqual(['过一遍 AITA 前 20 条', '挑 5 条改开头', '', '只筛不发做复盘'])
    expect(lines.filter((l) => l.done)).toEqual([])
    // 空行只是排版，不进分母
    expect(goalProgress(lines)).toEqual({ done: 0, total: 3 })
  })

  it('勾选只改被点那一行，其余行与空行一字不动', () => {
    const next = toggleGoalLine(THREE, 1)
    expect(next.split('\n')).toEqual([
      '过一遍 AITA 前 20 条',
      '- [x] 挑 5 条改开头',
      '',
      '只筛不发做复盘',
    ])
    expect(toggleGoalLine(THREE, 0).split('\n')[3]).toBe('只筛不发做复盘')
  })

  it('再点一次是取消而不是删标记：取消后仍是清单里的一行，还能再勾上', () => {
    const once = toggleGoalLine(THREE, 0)
    expect(parseGoalLines(once)[0].done).toBe(true)
    const twice = toggleGoalLine(once, 0)
    expect(twice.split('\n')[0]).toBe('- [ ] 过一遍 AITA 前 20 条')
    expect(parseGoalLines(twice)[0]).toMatchObject({ done: false, blank: false, content: '过一遍 AITA 前 20 条' })
    expect(parseGoalLines(toggleGoalLine(twice, 0))[0].done).toBe(true)
  })

  it('普通项目符号行升级成带框的那一行，不叠成两个符号', () => {
    expect(toggleGoalLine('- 买牛奶', 0)).toBe('- [x] 买牛奶')
    expect(toggleGoalLine('  * 买牛奶', 0)).toBe('  - [x] 买牛奶')
    // 已带框的行按原状态翻转，缩进保留
    expect(toggleGoalLine('   - [x] 缩进的条目', 0)).toBe('   - [ ] 缩进的条目')
  })

  it('换行风格保留：全文 CRLF 点一次勾不会把整段重排', () => {
    const crlf = '第一条\r\n第二条'
    const next = toggleGoalLine(crlf, 1)
    expect(next).toBe('第一条\r\n- [x] 第二条')
    expect(next.includes('\r\n')).toBe(true)
  })

  it('越界与空行原样返回（不猜一行）', () => {
    expect(toggleGoalLine(THREE, 99)).toBe(THREE)
    expect(toggleGoalLine(THREE, 2)).toBe(THREE)
  })

  it('完成数按勾选行算，勾满时分母不变', () => {
    let text = THREE
    text = toggleGoalLine(text, 0)
    text = toggleGoalLine(text, 1)
    expect(goalProgress(parseGoalLines(text))).toEqual({ done: 2, total: 3 })
    text = toggleGoalLine(text, 3)
    expect(goalProgress(parseGoalLines(text))).toEqual({ done: 3, total: 3 })
  })

  it('空目标不崩，也不是「0 条待办里已完成 0」的假象', () => {
    expect(parseGoalLines('')).toHaveLength(1)
    expect(goalProgress(parseGoalLines(''))).toEqual({ done: 0, total: 0 })
    expect(goalProgress(parseGoalLines('   \n\t'))).toEqual({ done: 0, total: 0 })
  })

  it('洗勾（D-220 沿用到新一天）：勾过的变未勾，裸行与空行一个字不动', () => {
    const carried = '- [x] 捞 5 条进今日\n裸行也是待办\n\n  - [x] 缩进那条'
    expect(clearGoalTicks(carried)).toBe('- [ ] 捞 5 条进今日\n裸行也是待办\n\n  - [ ] 缩进那条')
    expect(goalProgress(parseGoalLines(clearGoalTicks(carried)))).toEqual({ done: 0, total: 3 })
  })

  it('洗勾是幂等的，且不会把已经未勾的行改写', () => {
    const once = clearGoalTicks('- [ ] 没勾的\n- [x] 勾了的')
    expect(once).toBe('- [ ] 没勾的\n- [ ] 勾了的')
    expect(clearGoalTicks(once)).toBe(once)
    expect(clearGoalTicks('   ')).toBe('   ')
  })

  it('洗勾保留换行风格（CRLF 清单洗完不许变成 LF）', () => {
    const crlf = '- [x] 第一条\r\n- [x] 第二条'
    const next = clearGoalTicks(crlf)
    expect(next).toBe('- [ ] 第一条\r\n- [ ] 第二条')
    expect(next.includes('\r\n')).toBe(true)
  })
})
