/**
 * Mermaid 的判据（P2-4）。
 *
 * 这个功能的全部难点不在"画出一张图"，而在**时序**：渲染是同步的、分页是
 * 同步的、mermaid.render 是异步的。顺序错了就是"按源码高度排版、图一落地卡片
 * 就溢出"，而结构断言一条都不会红——溢出只在真浏览器/产物层看得见。
 *
 * 所以判据钉三件事：
 * 1. **预渲染 → 同步消费**：`applyTheme` 命中 cache 时同步落 SVG，命中不到时落源码；
 * 2. **失败不静默**：记 `render:mermaid` 诊断 + 源码仍然可见；
 * 3. **平台降级**：SVG 在微信/知乎清洗器里是被剥的，栅格化后必须变成 `<img>`。
 */
import { describe, expect, it } from 'vitest';

import {
  applyTheme,
  mermaidBlocksOf,
  mermaidCacheSignature,
  mermaidKeyOf,
  paginate,
  parseToIR,
  rasterizeMermaid,
  renderMermaidCache,
  xhsCards,
} from '../index';

const MD = [
  '# 图解',
  '',
  '```mermaid',
  'flowchart TD',
  '  A[起] --> B[落]',
  '```',
  '',
  '正文。',
].join('\n');

const SVG = '<svg viewBox="0 0 100 40"><rect width="100" height="40"/></svg>';

describe('cache 内容签名（宿主判断"这次结果变了没有"的唯一依据）', () => {
  const svg = (n: number) => '<svg>' + 'x'.repeat(n) + '</svg>';

  it('块数相同、内容不同 → 签名不同（这就是那个 bug）', () => {
    // 键是源码内容的哈希：改一个字，size 不变而键变了。
    const before = new Map([[mermaidKeyOf('flowchart TD\n A --> B'), svg(10)]]);
    const after = new Map([[mermaidKeyOf('flowchart TD\n A --> C'), svg(10)]]);

    expect(before.size).toBe(after.size);
    expect(mermaidCacheSignature(before)).not.toBe(mermaidCacheSignature(after));
  });

  it('内容与顺序都没变 → 签名相同（宿主才能交回同一个引用，不白重排）', () => {
    const a = new Map([
      [mermaidKeyOf('A'), svg(10)],
      [mermaidKeyOf('B'), svg(20)],
    ]);
    const b = new Map([
      [mermaidKeyOf('B'), svg(20)],
      [mermaidKeyOf('A'), svg(10)],
    ]);

    expect(mermaidCacheSignature(a)).toBe(mermaidCacheSignature(b));
  });

  it('同一份 cache 重复取签名稳定（不能每次调用都不同）', () => {
    const cache = new Map([[mermaidKeyOf('A'), svg(10)]]);

    expect(mermaidCacheSignature(cache)).toBe(mermaidCacheSignature(cache));
  });

  it('同键但 SVG 不同（主题切换）→ 签名不同', () => {
    const key = mermaidKeyOf('A');
    const light = new Map([[key, svg(10)]]);
    const dark = new Map([[key, svg(999)]]);

    expect(mermaidCacheSignature(light)).not.toBe(mermaidCacheSignature(dark));
  });

  it('undefined / 空 Map 都算"没有 cache"（首次渲染与清空走同一条路）', () => {
    expect(mermaidCacheSignature(undefined)).toBe('');
    expect(mermaidCacheSignature(null)).toBe('');
    expect(mermaidCacheSignature(new Map())).toBe('');
  });

  it('多图同键去重后仍按内容判同（省渲染不影响判同的正确性）', () => {
    const key = mermaidKeyOf('flowchart TD\n A --> B');
    const one = new Map([[key, svg(30)]]);
    const two = new Map([
      [key, svg(30)],
      [key, svg(30)],
    ]);

    // Map 按键去重，重复源码天然共用一份 SVG
    expect(one.size).toBe(1);
    expect(two.size).toBe(1);
    expect(mermaidCacheSignature(one)).toBe(mermaidCacheSignature(two));
  });
});

describe('发现与键', () => {
  it('只认 mermaid 语言块，键取自源码内容（与位置无关）', () => {
    const blocks = parseToIR(MD);
    const found = mermaidBlocksOf(blocks);
    expect(found).toHaveLength(1);
    expect(found[0].key).toBe(mermaidKeyOf(found[0].block.code));
  });

  it('同一段源码在稿子里出现两次 → 同一键（省一次渲染）', () => {
    const a = mermaidKeyOf('flowchart TD\n A --> B');
    const b = mermaidKeyOf('flowchart TD\n A --> B');
    expect(a).toBe(b);
    expect(mermaidKeyOf('flowchart TD\n A --> C')).not.toBe(a);
  });

  it('没有 mermaid 块时预渲染是空操作（不装载引擎）', async () => {
    let called = 0;
    const { cache, diagnostics } = await renderMermaidCache(parseToIR('# 纯文字'), {
      render: async () => {
        called += 1;
        return SVG;
      },
    });
    expect(called).toBe(0);
    expect(cache.size).toBe(0);
    expect(diagnostics).toEqual([]);
  });
});

describe('预渲染 → 同步消费', () => {
  it('命中 cache 时 applyTheme 同步落 SVG（分页量到的是图的真实结构）', async () => {
    const ir = parseToIR(MD);
    const { cache } = await renderMermaidCache(ir, { render: async () => SVG });
    const el = applyTheme(ir, 'modi', {}, globalThis.document, undefined, { mermaid: cache });
    const figure = el.querySelector('figure.mdcore-mermaid');
    expect(figure).toBeTruthy();
    expect(figure?.querySelector('svg')).toBeTruthy();
    // SVG 不再是代码块：产物里不该同时出现 pre>code
    expect(el.querySelector('pre code')).toBeNull();
  });

  it('没有 cache 时落回源码代码块（可读、可改，不是空白图框）', () => {
    const el = applyTheme(parseToIR(MD), 'modi');
    expect(el.querySelector('figure.mdcore-mermaid')).toBeNull();
    const pre = el.querySelector('.mdcore-code pre');
    expect(pre?.textContent).toContain('flowchart TD');
  });

  it('源码挂在 data-mdcore-mermaid 上（栅格化失败的降级通道）', async () => {
    const ir = parseToIR(MD);
    const { cache } = await renderMermaidCache(ir, { render: async () => SVG });
    const el = applyTheme(ir, 'modi', {}, globalThis.document, undefined, { mermaid: cache });
    expect(el.querySelector('figure.mdcore-mermaid')?.getAttribute('data-mdcore-mermaid')).toContain(
      'flowchart TD',
    );
  });

  it('分页与卡片都吃同一个 cache（漏传就等于小红书这一侧是瞎的）', async () => {
    const ir = parseToIR(MD);
    const { cache } = await renderMermaidCache(ir, { render: async () => SVG });
    const pages = paginate(ir, {
      theme: 'modi',
      page: { width: 600, height: 400, padding: 20 },
      mermaid: cache,
      measurer: { fits: () => true },
    });
    expect(pages[0].querySelector('figure.mdcore-mermaid')).toBeTruthy();
    const cards = xhsCards(ir, {
      theme: 'taoyao',
      doc: globalThis.document,
      mermaid: cache,
      measurer: { fits: () => true },
    });
    expect(cards.pages.some((p) => p.querySelector('figure.mdcore-mermaid'))).toBe(true);
  });
});

describe('失败不静默', () => {
  it('真引擎在 jsdom 里渲染不动时走的是"诊断 + 源码"这条路（不崩、不空图）', async () => {
    // mermaid 需要真实布局 API（getBBox 等），jsdom 里必然渲染失败。
    // 这条不是"环境不支持就算了"——它验的是**失败形态**：
    // 用户在真浏览器里看到的是图，在 jsdom/无布局环境里看到的是源码 + 横幅，
    // 而任何情况下都不该是一张空白图框或一次崩溃。
    const { cache, diagnostics } = await renderMermaidCache(parseToIR(MD));
    expect(cache.size).toBe(0);
    expect(diagnostics.map((d) => d.token)).toEqual(['render:mermaid']);
  }, 60000);

  it('渲染失败 → 记 render:mermaid 诊断，带源码行号', async () => {
    const { cache, diagnostics } = await renderMermaidCache(parseToIR(MD), {
      render: async () => {
        throw new Error('Parse error');
      },
    });
    expect(cache.size).toBe(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].token).toBe('render:mermaid');
    // 源码行号（0 基）指向围栏所在行，界面 +1 后是第 3 行
    expect(diagnostics[0].line).toBe(2);
  });

  it('多块失败合并成一条（同一语法只记一条，count 累加）', async () => {
    const md = ['```mermaid', 'bad', '```', '', '```mermaid', 'worse', '```'].join('\n');
    const { diagnostics } = await renderMermaidCache(parseToIR(md), {
      render: async () => {
        throw new Error('Parse error');
      },
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].count).toBe(2);
    expect(diagnostics[0].line).toBe(0);
  });

  it('一块失败不影响其余（成功的进 cache，失败的不进）', async () => {
    const md = [
      '```mermaid',
      'good',
      '```',
      '',
      '```mermaid',
      'bad',
      '```',
    ].join('\n');
    const { cache, diagnostics } = await renderMermaidCache(parseToIR(md), {
      render: async (code) => {
        if (code.trim() === 'bad') throw new Error('Parse error');
        return SVG;
      },
    });
    expect(cache.size).toBe(1);
    expect(diagnostics).toHaveLength(1);
  });

  it('显式关掉渲染（render: null）不记账——宿主自己说"这次别渲染"', async () => {
    const { cache, diagnostics } = await renderMermaidCache(parseToIR(MD), { render: null });
    expect(cache.size).toBe(0);
    expect(diagnostics).toEqual([]);
  });
});

describe('平台降级：SVG → 图片', () => {
  it('栅格化后 figure 内换成 <img src=dataURL>（微信/知乎剥 SVG）', async () => {
    const ir = parseToIR(MD);
    const { cache } = await renderMermaidCache(ir, { render: async () => SVG });
    const el = applyTheme(ir, 'modi', {}, globalThis.document, undefined, { mermaid: cache });
    const n = await rasterizeMermaid(el, { capture: async () => 'data:image/png;base64,AAA' });
    expect(n).toBe(1);
    const img = el.querySelector('figure.mdcore-mermaid img');
    expect(img?.getAttribute('src')).toBe('data:image/png;base64,AAA');
    expect(el.querySelector('figure.mdcore-mermaid svg')).toBeNull();
  });

  it('栅格化失败保留原 figure（宿主据此判失败，不留空图框）', async () => {
    const ir = parseToIR(MD);
    const { cache } = await renderMermaidCache(ir, { render: async () => SVG });
    const el = applyTheme(ir, 'modi', {}, globalThis.document, undefined, { mermaid: cache });
    const n = await rasterizeMermaid(el, {
      capture: async () => {
        throw new Error('no canvas');
      },
    });
    expect(n).toBe(0);
    expect(el.querySelector('figure.mdcore-mermaid svg')).toBeTruthy();
  });

  it('capture: null = 不栅格化（小红书/长图不需要：它们自己栅格化）', async () => {
    const ir = parseToIR(MD);
    const { cache } = await renderMermaidCache(ir, { render: async () => SVG });
    const el = applyTheme(ir, 'modi', {}, globalThis.document, undefined, { mermaid: cache });
    expect(await rasterizeMermaid(el, { capture: null })).toBe(0);
    expect(el.querySelector('figure.mdcore-mermaid svg')).toBeTruthy();
  });
});