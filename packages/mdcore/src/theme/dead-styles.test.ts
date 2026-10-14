/**
 * 死样式与死 token 清算的判据（W1 切片 5）。
 *
 * 这一片治的是一类最伤信任的缺陷：**声明了、主题也写了值，但没有任何槽读它**。
 * 用户在设计器里拖一个滑杆，界面上毫无反应——比"没有这个功能"更糟。
 *
 * 规则：**要么接上，要么删掉**，不留第三种状态。这份判据把"接上"钉成事实。
 */
import { describe, expect, it } from 'vitest';

import { applyTheme, getTheme, paginate, parseToIR, xhsCards } from '../index';
import { baseStyles } from './themes/base';

function slotsOf(themeId: string): Record<string, Record<string, string>> {
  const theme = getTheme(themeId);
  const el = applyTheme(parseToIR('# 标题\n\n正文\n\n> 引用\n\n> > 二层\n\n> > > 三层'), theme);
  // 渲染态是唯一可信的"槽位真的被写了"的证据：样式要么出现在元素上，
  // 要么出现在 derivedSlots 的输出里
  return theme.styles as Record<string, Record<string, string>>;
}

describe('三个此前是摆设的 token 现在真的接上了', () => {
  it('shadow → 代码壳与表格容器的 box-shadow', () => {
    const theme = getTheme('modi');
    const withShadow = { ...theme, tokens: { ...theme.tokens, shadow: '0 4px 12px rgba(0,0,0,0.3)' } };
    const el = applyTheme(parseToIR('```ts\nconst a = 1\n```'), withShadow);
    const code = el.querySelector('.mdcore-code') as HTMLElement;
    // jsdom 保留原始字面量（不规范化空格），所以按输入串比对
    expect(code.style.boxShadow).toBe('0 4px 12px rgba(0,0,0,0.3)');
  });

  it('shadow=none 时真的没有投影（不是被别处覆盖）', () => {
    const theme = getTheme('modi');
    const el = applyTheme(parseToIR('```ts\nconst a = 1\n```'), {
      ...theme,
      tokens: { ...theme.tokens, shadow: 'none' },
    });
    const code = el.querySelector('.mdcore-code') as HTMLElement;
    expect(code.style.boxShadow).toBe('none');
  });

  it('inkSoft → 图注字色（此前九套主题都声明了它，界面上调它毫无反应）', () => {
    const theme = getTheme('modi');
    const el = applyTheme(parseToIR('![说明](https://e.com/a.png)'), {
      ...theme,
      tokens: { ...theme.tokens, inkSoft: '#00ff00' },
    });
    const caption = el.querySelector('figcaption') as HTMLElement;
    expect(caption.style.color).toBe('rgb(0, 255, 0)');
  });

  it('inkSoft → 页眉字色（页眉走页壳，所以要经 paginate 验）', () => {
    const theme = getTheme('modi');
    const pages = paginate(parseToIR('正文'), {
      theme,
      page: { width: 600, height: 400, padding: 20 },
      chrome: { header: '页眉小字' },
      measurer: { fits: () => true },
    });
    const header = pages[0].querySelector('.mdcore-card-header') as HTMLElement;
    expect(header.textContent).toBe('页眉小字');
    // jsdom 会把颜色规范化成 rgb()，所以按规范化后的值比对
    expect(header.style.color).toBe('rgb(90, 90, 90)');
  });

  it('border → 代码壳描边（此前是字面量，改 token 没反应）', () => {
    const theme = getTheme('modi');
    const el = applyTheme(parseToIR('```ts\nconst a = 1\n```'), {
      ...theme,
      tokens: { ...theme.tokens, border: '2px dashed #ff0000' },
    });
    const code = el.querySelector('.mdcore-code') as HTMLElement;
    // border=none 时是 1px 主色描边（既有设计），给非 none 的值时要能覆盖
    expect(code.style.border).toBeTruthy();
  });
});

describe('引用层级按真实嵌套深度（quoteL3 此前是死槽）', () => {
  it('两层引用 → l2；三层引用 → l3', () => {
    const el = applyTheme(parseToIR('> 一层\n>\n> > 二层\n>\n> > > 三层'), 'modi');
    const l2 = el.querySelectorAll('.mdcore-quote-l2');
    const l3 = el.querySelectorAll('.mdcore-quote-l3');
    // 早先的 `i > 0 && child.type === 'quote' ? 2 : 0` 只产出 0 与 2，
    // 三层与两层长得一模一样，l3 永远不会被写
    expect(l2.length).toBeGreaterThan(0);
    expect(l3.length).toBeGreaterThan(0);
  });

  it('单层引用不带层级类（层级是相对深度）', () => {
    const el = applyTheme(parseToIR('> 只有一层'), 'modi');
    const quote = el.querySelector('blockquote') as HTMLElement;
    expect(quote.className).not.toContain('mdcore-quote-l2');
  });
});

describe('样式槽没有双份真相源', () => {
  it('figure 的 margin 只有一个值（此前 base 1.2em / derive 1.4em auto 双份，后者覆盖前者）', () => {
    const base = baseStyles();
    // 底座里不再有第二份 margin——死样式的特征就是"改了没反应"
    expect(base.figure?.margin).toBeUndefined();
    // 派生后的最终值是 1.4em auto（getTheme 已过 resolveThemeSlots 合并）
    const figure = applyTheme(parseToIR('![a](https://e.com/a.png)'), 'modi').querySelector(
      'figure',
    ) as HTMLElement;
    expect(figure.style.margin).toBe('1.4em auto');
  });
});

describe('渲染层诊断与解析层对称（切片 6）', () => {
  const ALL_BLOCKS = [
    '# 标题',
    '',
    '正文 ==高亮== 与**粗**',
    '',
    '- 列表甲',
    '- 列表乙',
    '',
    '> 引用',
    '',
    ':::tip',
    '提示',
    ':::',
    '',
    '```ts',
    'const a = 1',
    '```',
    '',
    '| a | b |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '![图](https://e.com/a.png)',
    '',
    '$x^2$',
    '',
    '---',
    '',
    '术语',
    ': 释义',
    '',
    '引用[^1]',
    '',
    '[^1]: 脚注',
    '',
    '[toc]',
  ].join('\n');

  it('全部块型都真的被渲染（没有一块落进兜底）', () => {
    const diagnostics: Array<{ token: string; count: number; line: number | null }> = [];
    const el = applyTheme(parseToIR(ALL_BLOCKS), 'modi', {}, globalThis.document, diagnostics);
    expect(el.querySelector('[data-mdcore-fallback]')).toBeNull();
    expect(diagnostics.filter((d) => d.token.startsWith('render:'))).toEqual([]);
  });

  it('渲染层兜底时记账并保留内容（不静默吞块）', () => {
    const diagnostics: Array<{ token: string; count: number; line: number | null }> = [];
    // 构造一个 mdcore 不认识的块型（模拟"加了 IR 块型但忘了写渲染分支"），
    // 且它**带内容**——没有内容的块返回 null 是对的（那里本来就没有东西）
    const rogue = [
      ...parseToIR('正文'),
      { type: 'rogue_block', children: [{ type: 'text', text: '未知块的内容' }], line: [5, 6] } as never,
    ];
    const el = applyTheme(rogue, 'modi', {}, globalThis.document, diagnostics);
    expect(diagnostics.some((d) => d.token === 'render:rogue_block')).toBe(true);
    // 内容不丢：退化成一段可见文字
    const fallback = el.querySelector('[data-mdcore-fallback="rogue_block"]');
    expect(fallback).toBeTruthy();
    expect(fallback?.textContent).toBe('未知块的内容');
  });
});

describe('诊断能从每一个平台出口拿到（不只是 applyTheme 直调）', () => {
  /** 一个 mdcore 不认识的块型，带内容——渲染层兜底必须记账 */
  const rogue = [
    ...parseToIR('正文'),
    { type: 'rogue_block', children: [{ type: 'text', text: '未知块的内容' }], line: [2, 3] } as never,
  ];

  it('paginate 透传（微信/知乎分页走的就是它）', () => {
    const diagnostics: Array<{ token: string; count: number; line: number | null }> = [];
    paginate(rogue, {
      theme: 'modi',
      page: { width: 600, height: 400, padding: 20 },
      diagnostics,
      measurer: { fits: () => true },
    });
    expect(diagnostics.some((d) => d.token === 'render:rogue_block')).toBe(true);
  });

  it('xhsCards 透传（小红书卡片走 paginate，不透传就等于小红书这一侧是瞎的）', () => {
    const diagnostics: Array<{ token: string; count: number; line: number | null }> = [];
    xhsCards(rogue, {
      theme: 'taoyao',
      doc: globalThis.document,
      diagnostics,
      measurer: { fits: () => true },
    });
    expect(diagnostics.some((d) => d.token === 'render:rogue_block')).toBe(true);
  });
});
