/**
 * 行内元素槽位的判据（W1 切片 3）。
 *
 * 这一片修的是"渲染了节点、却没有槽位"的一类缺口——它们全都只能写死样式：
 * ①行内图片复用**块级** `image` 槽，而那个槽带 `display:block; margin:0 auto`，
 *   于是段内插一张图整段被撑成块级并居中，图文流彻底断掉；
 * ②行内图片连 `{60% left}` 都不支持（字段只加在块级上）；
 * ③`[color:#xxx]` 彩色文字走 html 通道，主题管不到；
 * ④硬换行、列表项内容没有槽。
 */
import { describe, expect, it } from 'vitest';

import { applyTheme, parseToIR, WECHAT_FOOTNOTE } from '../index';

function inlineImg(md: string): HTMLElement {
  const el = applyTheme(parseToIR(md), 'modi');
  return el.querySelector('img') as HTMLElement;
}

describe('行内图片', () => {
  it('不继承块级槽的 display:block（图文流不���断）', () => {
    const img = inlineImg('这是一段文字 ![插图](https://e.com/a.png) 后面还有文字。');
    expect(img.style.display).toBe('inline-block');
    expect(img.style.margin).not.toBe('0px auto');
  });

  it('与块级图片是两套槽，互不影响', () => {
    const el = applyTheme(parseToIR('![独立成段](https://e.com/a.png)'), 'modi');
    const figure = el.querySelector('figure') as HTMLElement;
    const block = figure.querySelector('img') as HTMLElement;
    expect(block.style.display).toBe('block');
    // 块级仍然居中
    expect(block.style.margin).toContain('auto');
  });

  it('`{60% left}` 在行内图上也生效（此前字段只加在块级）', () => {
    const img = inlineImg('文字 ![插图](https://e.com/a.png){40% left} 尾字');
    expect(img.style.width).toBe('40%');
    expect(img.style.marginRight).toBe('auto');
  });

  it('宽度被夹在 10%~100%', () => {
    expect(inlineImg('x ![a](https://e.com/a.png){999% right} y').style.width).toBe('100%');
  });

  it('圆角仍跟着 imgRadius token（行内图也要有圆角）', () => {
    const img = inlineImg('文字 ![插图](https://e.com/a.png) 文字');
    expect(img.style.borderRadius).toBeTruthy();
  });
});

describe('其它行内/结构件', () => {
  it('彩色文字走自己的槽：作者写了色值，主题仍能补上自己的样式', () => {
    const el = applyTheme(parseToIR('重点在[color:#ff0000]这里[/color]'), 'modi');
    const colored = el.querySelector('.mdcore-colored') as HTMLElement;
    expect(colored).toBeTruthy();
    // 颜色仍在（作者写的）
    expect(colored.style.color).toBe('rgb(255, 0, 0)');
    // 且没有多包一层 span
    expect(colored.querySelector('span')).toBeNull();
  });

  it('列表项内容有自己的槽（此前完全没有）', () => {
    const el = applyTheme(parseToIR('- 一条很长的列表项内容'), 'modi');
    const content = el.querySelector('.mdcore-li-content') as HTMLElement;
    expect(content).toBeTruthy();
    expect(content.style.wordBreak).toBe('break-word');
  });

  it('硬换行渲染成 br（不是普通 span）', () => {
    const el = applyTheme(parseToIR('第一行  \n第二行'), 'modi');
    expect(el.querySelector('br')).toBeTruthy();
  });
});

describe('平台适配器的排版参数不再写死', () => {
  it('微信外链脚注用相对字号，不写死 12px（卡片正文 30px 时 12px 是"看不清"）', () => {
    expect(WECHAT_FOOTNOTE.refSize).toMatch(/em/);
    expect(WECHAT_FOOTNOTE.itemSize).toMatch(/em/);
    expect(WECHAT_FOOTNOTE.sectionMarginTop).toMatch(/em/);
  });
});
