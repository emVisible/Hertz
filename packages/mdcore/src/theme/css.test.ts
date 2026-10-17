/**
 * 主题导出独立 CSS 的判据（P2-2）。
 *
 * 核心判据是**纯净页面复现主题**：把同一份稿子渲染成两棵树——
 *   ① 内联样式树（applyTheme 的产物，产品里的画布）
 *   ② 剥光所有 inline style + 注入 themeToCss() 产物的树（分享形态的页面）
 * 然后逐元素逐属性比 getComputedStyle。
 *
 * 为什么必须逐属性比：slot→selector 映射表与 apply.ts 的 switch 是两份真相源，
 * 漂移的后果是"导出 CSS 少了几处排版"，而**两边各自的结构断言都不会红**。
 * 这条判据是唯一能把它变红的机制——少一处映射、多一处选择器、值写错一个字符，
 * 都会在这里现形。
 */
import { describe, expect, it } from 'vitest';

import { applyTheme, parseToIR, resolveThemeSlots, themeToCss } from '../index';
import { getTheme } from '../index';

/** 厨房水槽：把每一种槽位能落地的块型都摆进来 */
const KITCHEN_SINK = [
  '# 标题一',
  '## 标题二',
  '',
  '正文 ==荧光== 与**粗** 与*斜* 与 ~~删~~ 与 `行内` 与 [链接](https://a.com) 与上标^2^。',
  '',
  '#话题',
  '',
  '1. 有序一',
  '2. 有序二',
  '- [x] 已完成',
  '- [ ] 未完成',
  '',
  '> 一层引用',
  '>',
  '> > 二层引用',
  '',
  ':::tip',
  '提示块',
  ':::',
  '',
  '```ts title="a.ts"',
  'const a = 1; // 注释',
  'if (a) { print("x") }',
  '```',
  '',
  '| 列一 | 列二 |',
  '| :--- | ---: |',
  '| 甲 | 乙 |',
  '| 丙 | 丁 |',
  '',
  '![图注文字](https://e.com/a.png)',
  '',
  '![行内图](https://e.com/b.png){40% left}',
  '',
  '$$\\frac{a}{b}$$',
  '',
  '行内公式 $x^2$。',
  '',
  '---',
  '',
  '术语',
  ': 释义',
  '',
  '脚注引用[^1]',
  '',
  '[^1]: 脚注正文',
  '',
  '[toc]',
].join('\n');

/** 把 inline style 全剥掉，只留结构 */
function stripInline(root: HTMLElement): HTMLElement {
  for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
    (el as HTMLElement).removeAttribute?.('style');
  }
  return root;
}

/** 导出 CSS → 注入到 document，返回 <style> 便于清理 */
function injectCss(css: string): HTMLStyleElement {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  return style;
}

/** 需要逐属性比的白名单：与 platform/inline.ts 的 STYLE_WHITELIST 同族（em/px 归一化在 jsdom 里有损） */
function comparableProps(el: HTMLElement): string[] {
  const style = el.getAttribute('style') ?? '';
  return Array.from(new Set(Array.from(style.matchAll(/([a-z-]+)\s*:/g)).map((m) => m[1])));
}

/**
 * 内容驱动的属性，按元素形状排除。
 *
 * 这三个值来自**这篇稿子自己的写法**，而不是主题：静态 CSS 不可能知道
 * "这张表第二列是右对齐"、"这张图要 40% 宽且靠左"——那是 markdown 内容
 * 的一部分（对齐序列 `:---:`、图宽记号 `{40% left}`），由 apply.ts 按内容直写。
 * 把它们算成主题的锅，会逼 CSS 生成器去猜内容（那才是真错）。
 *
 * 只按**元素形状**排除，不是按属性名一刀切：正文段落的 `text-align: justify`
 * 是主题决策（`align` token），必须照常比——一刀切会把这个回归放过。
 */
function isContentDriven(el: HTMLElement, prop: string): boolean {
  const inTable = !!el.closest('.mdcore-table');
  const isCell = !!el.closest('th, td');
  const isImage = !!el.closest('figure.mdcore-figure');
  const isImg = el.tagName === 'IMG';
  // 表格的对齐是按列写的
  if (inTable && isCell && prop === 'text-align') return true;
  // 图宽/图对齐是按图写的
  if ((isImage || isImg) && (prop === 'width' || prop === 'margin')) return true;
  return false;
}

describe('导出 CSS 在纯净页面复现主题', () => {
  it('逐元素逐属性：注入 CSS 的计算值 === 内联样式的计算值', () => {
    const theme = getTheme('modi');
    const ir = parseToIR(KITCHEN_SINK);

    // ① 内联样式树
    const inline = applyTheme(ir, theme);
    document.body.appendChild(inline);

    // ② 剥光 + 注入导出 CSS
    const css = themeToCss(theme);
    const clean = stripInline(applyTheme(ir, theme));
    document.body.appendChild(clean);
    const style = injectCss(css);

    try {
      const mismatches: string[] = [];
      const inlineEls = [inline, ...Array.from(inline.querySelectorAll('*'))];
      const cleanEls = [clean, ...Array.from(clean.querySelectorAll('*'))];
      expect(cleanEls.length).toBe(inlineEls.length);

      for (let i = 0; i < inlineEls.length; i++) {
        const a = inlineEls[i] as HTMLElement;
        const b = cleanEls[i] as HTMLElement;
        // 结构一致性：同位置必须是同标签，否则映射表根本对错了元素
        if (a.tagName !== b.tagName) {
          mismatches.push(`#${i} 标签不一致：${a.tagName} vs ${b.tagName}`);
          continue;
        }
        const props = comparableProps(a).filter((p) => !isContentDriven(a, p));
        const ca = window.getComputedStyle(a);
        const cb = window.getComputedStyle(b);
        for (const prop of props) {
          const va = ca.getPropertyValue(prop);
          const vb = cb.getPropertyValue(prop);
          // jsdom 对未知属性两边都返回 ''，跳过空对空
          if (va === '' && vb === '') continue;
          if (va !== vb) {
            mismatches.push(
              `${a.tagName}.${a.className || '(无类)'} <${a.parentElement?.tagName}.${a.parentElement?.className}> ${prop}: inline=${va} css=${vb}`,
            );
          }
        }
      }
      expect(mismatches, `导出 CSS 与内联渲染不等价（${mismatches.length} 处）:\n${mismatches.join('\n')}`).toEqual([]);
    } finally {
      style.remove();
      inline.remove();
      clean.remove();
    }
  });

  it('覆盖率高：厨房水槽稿子上 CSS 命中的属性数 > 0（防止"全都不匹配"的空判据）', () => {
    const theme = getTheme('modi');
    const ir = parseToIR(KITCHEN_SINK);
    const inline = applyTheme(ir, theme);
    const clean = stripInline(applyTheme(ir, theme));
    document.body.appendChild(inline);
    document.body.appendChild(clean);
    const style = injectCss(themeToCss(theme));
    try {
      let hit = 0;
      let miss = 0;
      const inlineEls = [inline, ...Array.from(inline.querySelectorAll('*'))];
      const cleanEls = [clean, ...Array.from(clean.querySelectorAll('*'))];
      for (let i = 0; i < inlineEls.length; i++) {
        const props = comparableProps(inlineEls[i] as HTMLElement).filter(
          (p) => !isContentDriven(inlineEls[i] as HTMLElement, p),
        );
        const cb = window.getComputedStyle(cleanEls[i] as HTMLElement);
        for (const prop of props) {
          if (cb.getPropertyValue(prop) !== '') hit += 1;
          else miss += 1;
        }
      }
      // 判据不能空转：至少要有相当比例的属性真的被 CSS 命中
      expect(hit).toBeGreaterThan(0);
      expect(hit).toBeGreaterThan(miss / 2);
    } finally {
      style.remove();
      inline.remove();
      clean.remove();
    }
  });

  it('9 套内置主题各自都能导出（不是只有 modi 能）', () => {
    for (const id of ['modi', 'wanfeng', 'taoyao', 'qingjian', 'mucheng', 'xueshu', 'yehang', 'moan', 'qingning']) {
      const css = themeToCss(id);
      expect(css.length, `${id} 导出 CSS 为空`).toBeGreaterThan(200);
      expect(css).toContain('.mdcore-doc');
    }
  });

  it('深色主题导出深色配色（hljs-dark 那套）', () => {
    const css = themeToCss('wanfeng'); // 深色主题
    expect(css).toMatch(/hljs-keyword/);
    // 深色配色是浅色的反值——断言"深色的 keyword 色 ≠ 浅色的"
    const light = themeToCss('modi');
    const darkKeyword = /hljs-keyword\s*\{[^}]*color:\s*([^;]+);/.exec(css)?.[1];
    const lightKeyword = /hljs-keyword\s*\{[^}]*color:\s*([^;]+);/.exec(light)?.[1];
    expect(darkKeyword).toBeTruthy();
    expect(darkKeyword).not.toBe(lightKeyword);
  });

  it('overrides 生效：导出的是"这一稿"的 CSS，不是主题默认的', () => {
    const css = themeToCss('modi', { color: '#ff0000' });
    expect(css).toContain('#ff0000');
  });

  it('每个落地的槽位都被导出（没有槽被静默丢弃）', () => {
    const theme = getTheme('modi');
    const { styles } = resolveThemeSlots(theme, {});
    const css = themeToCss(theme);
    // hljs-* 是选择器本身，其余槽位应出现在映射表里（由 css.ts 的 SLOT_SELECTORS 覆盖）。
    // `blockBorder` 是已知死槽（派生有值、apply.ts 无消费者），故排除——它本就
    // 不会出现在任何渲染树上，parity 判据已覆盖其余全部。
    const nonHljs = Object.keys(styles).filter((k) => !/^hljs/.test(k) && k !== 'blockBorder');
    for (const slot of nonHljs) {
      const props = styles[slot];
      if (!props || !Object.keys(props).length) continue;
      // 槽的某个属性值应出现在 CSS 里（值出现 = 该槽至少被导出）
      const values = Object.values(props).filter((v) => v && !v.includes('${'));
      if (!values.length) continue;
      const found = values.some((v) => css.includes(v));
      expect(found, `槽位 "${slot}" 的属性值在导出 CSS 里找不到`).toBe(true);
    }
  });
});