import { describe, expect, it } from 'vitest'

import { modelState, modelStateTone } from './modelStatus'

// 浏览器实测抓到的形状：状态查询还没回来时，卡片把 `!data?.deps` 当结论，
// 于是两张卡都在指责「依赖未安装（请重新 uv sync）」——「我还没问到」被说成
// 「我查过并且坏了」，用户照着提示去跑一条本来就不需要的命令。

describe('modelState', () => {
  it('查询未回来 = checking，绝不报成依赖缺失', () => {
    expect(modelState({ loaded: false, error: false })).toBe('checking')
    expect(modelState({ loaded: false, error: false, deps: undefined, ready: undefined })).toBe(
      'checking',
    )
  })

  it('查询失败 = unavailable（可以重试），不是「模型未下载」', () => {
    expect(modelState({ loaded: false, error: true })).toBe('unavailable')
  })

  it('问到之后才谈依赖与就绪', () => {
    expect(modelState({ loaded: true, error: false, deps: false, ready: false })).toBe('noDeps')
    expect(modelState({ loaded: true, error: false, deps: true, ready: false })).toBe('missing')
    expect(modelState({ loaded: true, error: false, deps: true, ready: true })).toBe('ready')
  })

  it('deps 为真但结果缺失时也绝不判成 ready', () => {
    expect(modelState({ loaded: true, error: false, deps: true })).toBe('missing')
  })
})

describe('modelStateTone', () => {
  it('checking 中性、ready 绿、缺模型琥珀、缺依赖红', () => {
    expect(modelStateTone('checking')).toBe('neutral')
    expect(modelStateTone('ready')).toBe('success')
    expect(modelStateTone('missing')).toBe('warning')
    expect(modelStateTone('noDeps')).toBe('error')
    expect(modelStateTone('unavailable')).toBe('warning')
  })
})
