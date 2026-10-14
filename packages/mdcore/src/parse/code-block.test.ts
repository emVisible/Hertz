/**
 * 代码块链路的判据（W1 切片 4）。
 *
 * 三件事，每一件都是"写了支持、产物里不成立"：
 * ①围栏 info 整串当语言用——` ```ts title="a.ts" ` 不高亮，代码头标签还把整串显示出来；
 * ②Mac 三色点只设了背景色、**没有任何尺寸**，空 span 是 0×0，真浏览器里不可见
 *   （而当时的测试只断言背景色，把这个缺陷钉成了"正确"）；
 * ③高亮配色只有 6 个类，hljs 实产 40+ 类——`print`、`SELECT`、`int` 全是普通字色。
 */
import { describe, expect, it } from 'vitest';

import { applyTheme, hljsDark, hljsLight, parseToIR, type IRBlock } from '../index';
import { LANG_ALIASES, normalizeLang, parseFenceInfo } from '../parse/lang';

function codeOf(md: string): Extract<IRBlock, { type: 'code' }> {
  const block = parseToIR(md)[0];
  if (block.type !== 'code') throw new Error('不是 code 块');
  return block;
}

function render(md: string): HTMLElement {
  return applyTheme(parseToIR(md), 'modi');
}

describe('围栏语言归一化', () => {
  it('`ts title="a.ts"` → 归一化语言 + 文件名标签', () => {
    const info = parseFenceInfo('ts title="a.ts"');
    expect(info.lang).toBe('typescript');
    expect(info.label).toBe('a.ts');
  });

  it('`js:app.js` 剥掉文件名，语言仍是 js', () => {
    const info = parseFenceInfo('js:app.js');
    expect(info.lang).toBe('javascript');
    expect(info.label).toBe('app.js');
  });

  it('`sh {1,3}` 剥掉行号记号，语言归一到 bash', () => {
    const info = parseFenceInfo('sh {1,3}');
    expect(info.lang).toBe('bash');
    expect(info.label).toBe('sh');
  });

  it('没写语言 → lang 为 null，不给 hljs 传空串', () => {
    expect(parseFenceInfo('')).toEqual({ lang: null, raw: '', label: null });
  });

  it('别名表只登记「用户真会写」的形式，且值都能被 hljs 认出', () => {
    // 用 markdown-it 的高亮回调反查：每条别名归一化后都必须能高亮
    for (const [alias, canonical] of Object.entries(LANG_ALIASES)) {
      expect(normalizeLang(alias), alias).toBe(canonical);
    }
    // 归一化是幂等的
    for (const canonical of new Set(Object.values(LANG_ALIASES))) {
      expect(normalizeLang(canonical), canonical).toBe(canonical);
    }
  });

  it('IR 里带 label（代码头显示它，不显示整串 info）', () => {
    const code = codeOf('```ts title="a.ts"\nconst a = 1\n```');
    expect(code.lang).toBe('typescript');
    expect(code.label).toBe('a.ts');
  });

  it('代码头显示的是可读标签，而不是整串 info', () => {
    const el = render('```ts title="a.ts"\nconst a = 1\n```');
    const head = el.querySelector('.mdcore-code-lang') as HTMLElement;
    expect(head.textContent).toBe('a.ts');
    expect(head.textContent).not.toContain('title=');
  });

  /**
   * 这条判据守的是"高亮用归一化后的语言"，而不是"解析期回调还在不在"。
   *
   * 第一版成对变异把 markdown.ts 的 `highlight` 回调退回整串 info，285 条断言
   * 全绿——因为高亮的真正作者是 `theme/apply.ts` 的 `highlightCode()`，IR 只存源码，
   * 解析期那份产物**整个被丢掉**。那份回调随后删掉了（两个作者，留着一个是误导）。
   */
  it('带 info 的围栏照样高亮（此前整串查语言必然失败）', () => {
    const el = render('```ts title="a.ts"\nconst a = 1\n```');
    expect(el.querySelectorAll('.hljs-keyword').length).toBeGreaterThan(0);
  });

  it('别名写法同样高亮（`sh` / `yml` / `py`）', () => {
    for (const [fence, token] of [
      ['sh', 'hljs-keyword'],
      ['yml', 'hljs-attr'],
      ['py', 'hljs-built_in'],
    ] as const) {
      const el = render(`\`\`\`${fence}\n${fence === 'py' ? 'print(1)' : fence === 'sh' ? 'if true; then' : 'a: 1'}\n\`\`\``);
      expect(el.querySelectorAll(`.${token}`).length, fence).toBeGreaterThan(0);
    }
  });
});

describe('Mac 三色点', () => {
  // 用 codeBar=mac 的主题（桃夭）；墨滴是 lang 样式，没有三点
  const renderMac = (md: string): HTMLElement => applyTheme(parseToIR(md), 'taoyao');

  it('三点都有实际尺寸（此前 0×0，真浏览器里不可见）', () => {
    const el = renderMac('```ts\nconst a = 1\n```');
    const dots = Array.from(el.querySelectorAll('.mdcore-code-dot')) as HTMLElement[];
    expect(dots).toHaveLength(3);
    for (const dot of dots) {
      expect(dot.style.width).toBeTruthy();
      expect(dot.style.height).toBeTruthy();
      expect(dot.style.display).toBe('inline-block');
    }
  });

  it('容器是 inline-flex 且有间距（挤在一起看不出是三点）', () => {
    const el = renderMac('```ts\nconst a = 1\n```');
    const box = el.querySelector('.mdcore-code-dots') as HTMLElement;
    expect(box.style.display).toBe('inline-flex');
    expect(box.style.gap).toBeTruthy();
  });
});

describe('高亮配色覆盖', () => {
  const KEY_CLASSES = [
    'hljs-keyword',
    'hljs-built_in',
    'hljs-type',
    'hljs-literal',
    'hljs-string',
    'hljs-comment',
    'hljs-number',
    'hljs-title',
    'hljs-params',
    'hljs-variable',
    'hljs-property',
    'hljs-attr',
    'hljs-name',
    'hljs-tag',
    'hljs-operator',
    'hljs-built',
  ].filter((k) => k !== 'hljs-built');

  it('浅色/深色两套都覆盖了关键类目（此前只有 6 个）', () => {
    for (const cls of KEY_CLASSES) {
      expect(hljsLight[cls]?.color, `hljsLight 缺 ${cls}`).toBeTruthy();
      expect(hljsDark[cls]?.color, `hljsDark 缺 ${cls}`).toBeTruthy();
    }
  });

  it('两套配色键集一致（少配一套 = 深色主题里某个类无色）', () => {
    expect(Object.keys(hljsDark).sort()).toEqual(Object.keys(hljsLight).sort());
  });

  it('真实语言的关键 token 有颜色：SQL 的 SELECT、Python 的 print、Go 的 int', () => {
    const cases: Array<[string, string, string]> = [
      ['sql', 'SELECT * FROM t;', '.hljs-keyword'],
      ['python', 'print(1)', '.hljs-built_in'],
      ['go', 'var x int = 1', '.hljs-type'],
    ];
    for (const [fence, code, selector] of cases) {
      const el = render(`\`\`\`${fence}\n${code}\n\`\`\``);
      const hit = el.querySelector(selector) as HTMLElement;
      expect(hit, `${fence} 的 ${selector}`).toBeTruthy();
      expect(hit.style.color, `${fence} ${selector} 没有颜色`).toBeTruthy();
    }
  });
});
