/**
 * 排版深度（W3）的判据。
 *
 * 现状：设计器有 37 个控件，但**排版深度这一层几乎是空的**——
 * ①标题阶跃 `1.7/1.4/1.18/1.05/1/0.94` **写死**在 base.ts，没有一个旋钮；
 * ②组件级字号（图注 0.82em、代码、表格、列表项）全部隐式跟正文走，
 *   想让"正文大一点、图注小一点"这种最常见的比例关系，**做不到**；
 * ③密度只管到段距与章节距，列表项间距、代码行距、单元格内边距都没有。
 *
 * 这三样是"排版像不像给人看的"的主要来源，也是设计器**声称**能做而实际做不到的。
 * 判据按"要么接上、要么删掉"的口径写：**声明了就必须真的作用到产物上**。
 */
import { describe, expect, it } from 'vitest'

import { applyTheme, getTheme, parseToIR } from '../index'
import { baseStyles } from './themes/base'

const MD = [
  '# 一级',
  '',
  '正文一段。',
  '',
  '## 二级',
  '',
  '正文二段。',
  '',
  '### 三级',
  '',
  '正文三段。',
  '',
  '> 引用一段。',
  '',
  '```ts',
  'const a = 1',
  '```',
  '',
  '| 列 | 值 |',
  '| --- | --- |',
  '| 甲 | 1 |',
  '',
  '- 列表一',
  '- 列表二',
  '',
  '![图注](https://e.com/a.png)',
].join('\n')

function renderWith(tokens: Record<string, string>): HTMLElement {
  const theme = getTheme('modi')
  return applyTheme(parseToIR(MD), { ...theme, tokens: { ...theme.tokens, ...tokens } as never })
}

function styleOf(el: Element | null, prop: string): string {
  return (el as HTMLElement | null)?.style.getPropertyValue(prop) ?? ''
}

describe('标题阶跃可调（此前写死，无旋钮）', () => {
  it('step 越大层级越陡、越小越平（单调且可解释）', () => {
    const ratio = (step: string) => {
      const el = renderWith({ headingStep: step })
      const h1 = parseFloat((el.querySelector('h1') as HTMLElement).style.fontSize)
      const h3 = parseFloat((el.querySelector('h3') as HTMLElement).style.fontSize)
      return h3 / h1
    }
    // step=1 时精确复现历史阶梯 1.18/1.7
    expect(ratio('1')).toBeCloseTo(1.18 / 1.7, 2)
    expect(ratio('1.2')).toBeLessThan(ratio('1'))
    expect(ratio('0.9')).toBeGreaterThan(ratio('1'))
  })

  it('默认阶跃保持原来的样子（1.7/1.4/1.18 —— 改东西不该顺手改掉既有版式）', () => {
    const el = applyTheme(parseToIR(MD), 'modi')
    expect(styleOf(el.querySelector('h1'), 'font-size')).toBe('1.7em')
    expect(styleOf(el.querySelector('h2'), 'font-size')).toBe('1.4em')
  })
})

describe('组件级字号（此前全部隐式跟正文走）', () => {
  it('caption 单独一个字号：正文不动、图注变', () => {
    const el = renderWith({ captionSize: '0.7em' })
    expect(styleOf(el.querySelector('figcaption'), 'font-size')).toBe('0.7em')
    // 正文没被连带改掉——这才是"分级尺寸"的意义
    expect(parseFloat(getComputedStyle(el).fontSize) || 16).toBeTruthy()
    expect(styleOf(el.querySelector('p'), 'font-size')).toBe('')
  })

  it('quote 字号与引用样式是两个旋钮（以前只能改样式、改不了字号）', () => {
    const el = renderWith({ quoteSize: '0.95em' })
    expect(styleOf(el.querySelector('blockquote'), 'font-size')).toBe('0.95em')
  })

  it('code 字号独立于正文（技术稿常要小一号）', () => {
    const el = renderWith({ codeSize: '0.88em' })
    // 挂在 `code` 槽：行内代码与块级代码共用它（块级是 <pre><code>），只此一处
    expect(styleOf(el.querySelector('.mdcore-code code'), 'font-size')).toBe('0.88em')
  })

  it('table 字号独立（窄表最需要小一号）', () => {
    const el = renderWith({ tableSize: '0.92em' })
    expect(styleOf(el.querySelector('table'), 'font-size')).toBe('0.92em')
  })
})

describe('密度项（此前只有段距与章节距）', () => {
  it('列表项间距可调', () => {
    const el = renderWith({ listSpacing: '0.4em' })
    expect(styleOf(el.querySelector('li'), 'margin-bottom')).toBe('0.4em')
  })

  it('代码行距可调（等宽字行距太小会挤成一坨）', () => {
    const el = renderWith({ codeLineHeight: '1.7' })
    expect(styleOf(el.querySelector('.mdcore-code code'), 'line-height')).toBe('1.7')
  })

  it('单元格内边距可调（表格挤不挤全看它）', () => {
    const el = renderWith({ tableCellPad: '0.7em' })
    expect(styleOf(el.querySelector('td'), 'padding')).toBe('0.7em')
  })
})

describe('token 一律赢过主题自带的写法', () => {
  /**
   * 为什么单列一条：derive 的 depthSlots 是**最后合并**的，所以即使某个主题（或
   * 将来某个人）在 baseStyles 里把 `codeSize` 写死，token 也压得住。
   * 第一版判据只验了"token 生效"，没验"写死的那份不生效"——于是把 base 改成写死值
   * 的变异是全绿的。**旋钮要真旋钮：写死的值不许赢。**
   */
  it('baseStyles 里把字号写死，也压不过 token', () => {
    const base = baseStyles()
    // base 自带的回落值仍是默认值
    expect((base.code as Record<string, string>)['font-size']).toBe('0.86em')
    // 但产物读的是 token 给的那个
    const el = renderWith({ codeSize: '0.7em' })
    expect(styleOf(el.querySelector('.mdcore-code code'), 'font-size')).toBe('0.7em')
  })

  it('标题同理：主题写死阶梯也压不过 headingStep', () => {
    const base = baseStyles()
    expect((base.h2 as Record<string, string>)['font-size']).toBe('1.4em')
    const el = renderWith({ headingStep: '1.3' })
    expect(styleOf(el.querySelector('h2'), 'font-size')).not.toBe('1.4em')
  })
})

describe('新旋钮不能悄悄改坏既有版式', () => {
  it.each(['modi', 'taoyao', 'qingjian', 'wanfeng', 'yehang'])(
    '%s 用默认值渲染出的尺寸与改动前一致',
    (id) => {
      const el = applyTheme(parseToIR(MD), id)
      // 默认值必须等于原写死的那几个数，否则这一刀下去所有既有基线都会动
      expect(styleOf(el.querySelector('h1'), 'font-size')).toBe('1.7em')
      expect(styleOf(el.querySelector('figcaption'), 'font-size')).toBe('0.82em')
      expect(styleOf(el.querySelector('blockquote'), 'font-size')).toBe('0.97em')
      expect(styleOf(el.querySelector('.mdcore-code code'), 'line-height')).not.toBe('')
    },
  )
})