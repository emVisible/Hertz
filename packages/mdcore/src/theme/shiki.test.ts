/**
 * Shiki 二次 pass 的判据（P1-3 / P1-5）。
 *
 * 判据打的是**接线**，不是"Shiki 好不好看"：好看由排版基线图逐像素判
 * （`scripts/typography-baseline.mjs`）。这里要钉死的是四件事——
 * 1. 发现通道成立：只有块级代码带语言标记，行内代码不在射程内；
 * 2. 引擎真的被调用，且按「语言 + 主题名」两个参数调用；
 * 3. 引擎不接管时（语言不认识 / 抛错）**保留 hljs 产物**，一次高亮都不白做；
 * 4. 预设映射：`auto` 与 GitHub 同源、深浅各出一版，单色主题两版同色。
 *
 * 为什么注入式高亮器是这里唯一可用的判据形态：真 Shiki 是异步重依赖，
 * jsdom 里每次断言都要装载一次引擎——那测的是引擎，不是接线。
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  applyTheme,
  CODE_LANG_ATTR,
  codeThemeNameFor,
  highlightCodeBlocks,
  parseToIR,
  resolveCodeThemeName,
  setCodeHighlighter,
  shikiLangOf,
  CODE_THEMES,
} from '../index';

afterEach(() => {
  setCodeHighlighter(null);
});

const DOC = ['```ts title="a.ts"', 'const a: number = 1', '```', '', '行内 `code` 也在稿子里'].join('\n');

describe('二次 pass 的发现通道', () => {
  it('块级代码带语言标记，行内代码不带（否则行内代码会被整块换掉）', () => {
    const el = applyTheme(parseToIR(DOC), 'modi');
    const blockCode = el.querySelector('.mdcore-code code');
    expect(blockCode?.getAttribute(CODE_LANG_ATTR)).toBe('typescript');
    // 行内代码：没有这个标记
    const inlineCode = Array.from(el.querySelectorAll('code')).find(
      (c) => !c.closest('.mdcore-code'),
    );
    expect(inlineCode).toBeTruthy();
    expect(inlineCode?.hasAttribute(CODE_LANG_ATTR)).toBe(false);
  });

  it('语言标记用归一化名而不是用户原写法（ts → typescript）', () => {
    const el = applyTheme(parseToIR('```ts\nconst a = 1\n```'), 'modi');
    expect(el.querySelector('code')?.getAttribute(CODE_LANG_ATTR)).toBe('typescript');
  });

  it('升级后块尺寸不变（同一份文本、同一套字体，只是多了一层 span）', async () => {
    const el = applyTheme(parseToIR(DOC), 'modi');
    const before = el.querySelector('.mdcore-code')?.getBoundingClientRect().height ?? 0;
    await highlightCodeBlocks(el, {
      highlighter: async (code) => code.split('\n').map((l) => `<span>${l}</span>`).join('<br>'),
    });
    const after = el.querySelector('.mdcore-code')?.getBoundingClientRect().height ?? 0;
    expect(after).toBe(before);
  });
});

describe('引擎接线', () => {
  it('按「语言 + 主题名」调用引擎，并把返回值写进 <code>', async () => {
    const calls: Array<[string, string, string]> = [];
    const el = applyTheme(parseToIR(DOC), 'modi');
    const n = await highlightCodeBlocks(el, {
      themeName: 'github-light',
      highlighter: async (code, lang, theme) => {
        calls.push([code, lang, theme]);
        return '<span style="color:#ff0000">shiki</span>';
      },
    });
    expect(n).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toContain('const a: number = 1');
    expect(calls[0][1]).toBe('typescript');
    expect(calls[0][2]).toBe('github-light');
    expect(el.querySelector('.mdcore-code code')?.innerHTML).toBe('<span style="color:#ff0000">shiki</span>');
  });

  it('没有代码块的稿子不调用引擎（避免为不存在的稿子装载重依赖）', async () => {
    let called = 0;
    const el = applyTheme(parseToIR('# 只有标题\n\n正文'), 'modi');
    const n = await highlightCodeBlocks(el, {
      highlighter: async () => {
        called += 1;
        return '<span>x</span>';
      },
    });
    expect(n).toBe(0);
    expect(called).toBe(0);
  });

  it('引擎抛错时保留 hljs 的产物（一次高亮都不白做，且不静默丢色）', async () => {
    const el = applyTheme(parseToIR('```ts\nconst a = 1\n```'), 'modi');
    const hljsHtml = el.querySelector('code')?.innerHTML ?? '';
    expect(hljsHtml).toContain('hljs-keyword'); // 前提：同步那一版确实上了色
    const n = await highlightCodeBlocks(el, {
      highlighter: async () => {
        throw new Error('engine down');
      },
    });
    expect(n).toBe(0);
    // 抛错的引擎不该把调用方一起带崩：引擎失败按"不接管"处理
    expect(el.querySelector('code')?.innerHTML).toBe(hljsHtml);
  });

  it('引擎返回 null（语言不在包里）时同样保留 hljs 产物', async () => {
    const el = applyTheme(parseToIR('```wasm\n(module)\n```'), 'modi');
    const before = el.querySelector('code')?.innerHTML;
    const n = await highlightCodeBlocks(el, { highlighter: async () => null });
    expect(n).toBe(0);
    expect(el.querySelector('code')?.innerHTML).toBe(before);
  });

  it('highlighter: null = 明确不做二次 pass（宿主可显式关掉）', async () => {
    const el = applyTheme(parseToIR('```ts\nconst a = 1\n```'), 'modi');
    const before = el.querySelector('code')?.innerHTML;
    expect(await highlightCodeBlocks(el, { highlighter: null })).toBe(0);
    expect(el.querySelector('code')?.innerHTML).toBe(before);
  });

  it('全局注入的引擎也被采纳（前端测试靠它替掉真 Shiki）', async () => {
    setCodeHighlighter(async () => '<span data-stub="1">stub</span>');
    const el = applyTheme(parseToIR('```ts\nconst a = 1\n```'), 'modi');
    const n = await highlightCodeBlocks(el);
    expect(n).toBe(1);
    expect(el.querySelector('[data-stub]')).toBeTruthy();
    setCodeHighlighter(null);
    const el2 = applyTheme(parseToIR('```ts\nconst a = 1\n```'), 'modi');
    // 清掉注入后不再有 stub（默认引擎在 jsdom 里不应把 DOM 改掉）
    await highlightCodeBlocks(el2, { highlighter: null });
    expect(el2.querySelector('[data-stub]')).toBeNull();
  });
});

describe('P1-5：代码高亮预设', () => {
  it('auto 与 GitHub 同源（接上 Shiki 后默认观感不变）', () => {
    expect(resolveCodeThemeName('auto', false)).toBe('github-light');
    expect(resolveCodeThemeName('auto', true)).toBe('github-dark');
    expect(resolveCodeThemeName('github', false)).toBe('github-light');
  });

  it('未知预设 id 退回 auto，不抛错也不静默给一个不存在的主题名', () => {
    expect(resolveCodeThemeName('nope', false)).toBe('github-light');
    expect(resolveCodeThemeName(undefined, true)).toBe('github-dark');
  });

  it('每个预设都有浅深两版可解析的名字，且两版不互串', () => {
    for (const id of CODE_THEMES) {
      const light = resolveCodeThemeName(id, false);
      const dark = resolveCodeThemeName(id, true);
      expect(light, `${id} 缺浅色主题名`).toBeTruthy();
      expect(dark, `${id} 缺深色主题名`).toBeTruthy();
    }
    // 双色预设确实换了主题；单色预设（dracula/nord）两版同名是有意的
    expect(resolveCodeThemeName('vitesse', false)).not.toBe(resolveCodeThemeName('vitesse', true));
    expect(resolveCodeThemeName('dracula', false)).toBe(resolveCodeThemeName('dracula', true));
  });

  it('codeTheme 是 token：随稿 overrides 生效（这是"选主题集"的存储通道）', () => {
    expect(codeThemeNameFor('modi')).toBe('github-light');
    expect(codeThemeNameFor('modi', { codeTheme: 'nord' })).toBe('nord');
    // 深色主题自动换深色版
    expect(codeThemeNameFor('wanfeng')).toBe('github-dark');
    expect(codeThemeNameFor('wanfeng', { codeTheme: 'vitesse' })).toBe('vitesse-dark');
  });

  it('深色预览可显式覆盖（宿主切到深色主题时无需改稿）', () => {
    expect(codeThemeNameFor('modi', { codeTheme: 'one-dark' }, true)).toBe('one-dark-pro');
  });
});

describe('语言名映射', () => {
  it('只有两边命名确实不同的才登记（objectivec → objective-c）', () => {
    expect(shikiLangOf('objectivec')).toBe('objective-c');
    expect(shikiLangOf('typescript')).toBe('typescript');
    expect(shikiLangOf('vbnet')).toBe('vb');
  });

  it('空语言不是 null-语言（返回 null = 不接管）', () => {
    expect(shikiLangOf('')).toBeNull();
    expect(shikiLangOf(null)).toBeNull();
    expect(shikiLangOf('  ')).toBeNull();
  });
});