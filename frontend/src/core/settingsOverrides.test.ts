import { describe, expect, it } from 'vitest'

import { buildOverrides, coerceFromBase } from './settingsOverrides'

// v0.20 拆分把 save() 的字段表删成 `overrides: {}`：设置页从此只演出不落盘
// （点保存弹「已保存」，runtime.yaml 一个字节没写），且 toast 说得跟真的一样。
// 这批测试钉的是「改动确实进载荷」这件事本身，不是某个字段的形状。

describe('buildOverrides', () => {
  it('被改过的字段进入载荷，未改动的不进入', () => {
    const cfg = { pipeline_min_score: 6, pipeline_subtitle_lang: 'zh-CN' }
    const out = buildOverrides(cfg, {
      pipeline_min_score: '9',
      pipeline_subtitle_lang: 'zh-CN',
    })
    expect(out).toEqual({ pipeline_min_score: 9 })
  })

  it('类型按配置真值还原：布尔不是字符串 "false"（Python 里非空字符串为真）', () => {
    const cfg = { telegram_enabled: true, pipeline_auto_publish: false }
    const out = buildOverrides(cfg, {
      telegram_enabled: 'false',
      pipeline_auto_publish: 'false',
    })
    expect(out).toEqual({ telegram_enabled: false })
  })

  it('数组字段（逗号串）按数组回传，顺序变化算改动', () => {
    const cfg = { pipeline_sources: ['hot', 'reddit'] }
    expect(buildOverrides(cfg, { pipeline_sources: 'hot, reddit' })).toEqual({})
    expect(buildOverrides(cfg, { pipeline_sources: 'reddit,hot' })).toEqual({
      pipeline_sources: ['reddit', 'hot'],
    })
  })

  it('配置里没有的只写字段：留空 = 不动，填了才写（否则清掉已存 cookie/secret）', () => {
    const out = buildOverrides({ data_dir: '/x' }, {
      pipeline_reddit_cookie: '',
      pipeline_reddit_client_secret: '',
      data_dir: '/x',
    })
    expect(out).toEqual({})
    expect(buildOverrides({}, { pipeline_reddit_cookie: 'abc' })).toEqual({
      pipeline_reddit_cookie: 'abc',
    })
  })

  it('用户清空一个字符串设置时要真的写回空串（不能被当成"没改"）', () => {
    expect(buildOverrides({ pipeline_hf_endpoint: 'https://hf-mirror.com' }, {
      pipeline_hf_endpoint: '',
    })).toEqual({ pipeline_hf_endpoint: '' })
  })

  it('cfg 尚未加载（undefined）时不炸——首帧就点保存也要有确定行为', () => {
    expect(buildOverrides(undefined, { a: '1' })).toEqual({ a: '1' })
    expect(buildOverrides(null, {})).toEqual({})
  })
})

describe('coerceFromBase', () => {
  it('null 基线（后端把空目录回填成字符串前的形态）按字符串处理', () => {
    expect(coerceFromBase(null, 'zh')).toBe('zh')
  })
})
