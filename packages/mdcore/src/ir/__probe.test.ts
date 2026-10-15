import { describe, expect, it } from 'vitest'
import { applyTheme, getTheme, parseToIRDetailed } from '../index'
const CASES: Record<string, string> = {
  ruby_v1: '汉字[拼音](hàn zì)',
  ruby_v2: '汉字{拼音|hàn zì}',
  ruby_html: '<ruby>汉字<rt>hàn zì</rt></ruby>',
  ruby_rb: '[汉字]{ruby|hàn zì}',
}
describe('probe ruby', () => {
  it('量', () => {
    for (const [k, v] of Object.entries(CASES)) {
      const ir = parseToIRDetailed(v)
      const el = applyTheme(ir.blocks, getTheme('modi'))
      console.log(`${k}: text=[${(el.textContent ?? '').trim()}] ruby元素=${el.querySelectorAll('ruby').length} diag=${ir.diagnostics.map(d=>d.token).join(',') || '-'}`)
    }
    expect(true).toBe(true)
  })
})
