import { describe, expect, it } from 'vitest'

import { boardQuery, dayWindow, wallDay } from './boardWindow'

describe('wallDay', () => {
  it('用本地墙上日期而不是 UTC 日期', () => {
    // 本地晚上八点：`toISOString().slice(0,10)` 在东八区会给出同一天、在西三区会给出
    // 第二天——两种都错，看板必须显示用户日历上的那一天。
    const evening = new Date(2034, 6, 1, 20, 0, 0)
    expect(wallDay(evening)).toBe('2034-07-01')
    expect(wallDay(new Date(2034, 0, 5, 0, 30))).toBe('2034-01-05')
  })
})

describe('dayWindow', () => {
  it('区间是本地零点起的一整天，且半开', () => {
    const { from, to } = dayWindow('2034-07-01')
    const start = new Date(from)
    const end = new Date(to)
    // 起点落在用户那天的 00:00:00.000（本地）
    expect([start.getFullYear(), start.getMonth(), start.getDate(), start.getHours(), start.getMinutes()]).toEqual([
      2034, 6, 1, 0, 0,
    ])
    // 终点是次日本地零点：差值恰好一天 ⇒ 午夜那一瞬只归一天（含两端会数两遍）
    expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000)
    expect(end.getDate()).toBe(2)
    expect(from.endsWith('Z')).toBe(true)
  })

  it('月末/年末进位交给 Date 自己算，不手写 31 号', () => {
    const { to } = dayWindow('2034-01-31')
    expect(new Date(to).getMonth()).toBe(1) // 2 月
    expect(new Date(dayWindow('2034-12-31').to).getFullYear()).toBe(2035)
  })

  it('格式不对就抛，不静默给一个空区间', () => {
    // 静默的 Invalid Date 会让看板变成「今天一条都没有」——那正是被坑过的形状
    expect(() => dayWindow('2034-7-1')).toThrow('YYYY-MM-DD')
    expect(() => dayWindow('')).toThrow()
  })
})

describe('boardQuery', () => {
  it('三个参数齐全且能被后端原样解出', () => {
    const q = new URLSearchParams(boardQuery('2034-07-01'))
    expect(q.get('date')).toBe('2034-07-01')
    expect(q.get('from')).toBe(dayWindow('2034-07-01').from)
    expect(q.get('to')).toBe(dayWindow('2034-07-01').to)
  })
})
