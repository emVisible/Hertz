import { describe, expect, it } from 'vitest';
import { adjustBreak, codeBreak, paginate, parseToIR } from '../index';
import type { Measurer } from '../index';

/**
 * 分页引擎测试（§7）：jsdom 不做真实排版，注入 mock Measurer 合成块高，
 * 钉断点选择 / 表格跨页表头 / 孤行标题 / 避头尾 / 英文不拆词。
 */

const LINE_H = 20; // 每行高
const CPL = 10; // 每行字符数
const HEAD_H = 40; // 标题块高
const IMG_H = 60; // 图片块高

/** 合成块高：标题 40；表格 表头+行 各 20；pre 按换行计行；图片 60；其余按字符折行 */
function blockHeight(el: HTMLElement): number {
  if (el.matches('h1,h2,h3,h4,h5,h6')) return HEAD_H;
  // 表格的块元素现在是 `.mdcore-table-wrap`（窄表横滚容器，W1 切片 2），
  // 认 table 本身会退化成"按文本长度估高"，分页结果就跟着错
  const table = el.matches('table') ? el : el.querySelector('table');
  if (table) {
    const head = table.querySelector('thead') ? 1 : 0;
    return (head + table.querySelectorAll('tbody tr').length) * LINE_H;
  }
  // v0.36：代码块外面套了 .mdcore-code 卡片壳，图片变成 figure > img + figcaption
  if (el.matches('pre') || el.querySelector('pre')) {
    const code = el.querySelector('code');
    return ((code ?? el).textContent ?? '').split('\n').length * LINE_H;
  }
  if (el.matches('img') || el.querySelector('img')) return IMG_H;
  const len = (el.textContent ?? '').length;
  return Math.max(1, Math.ceil(len / CPL)) * LINE_H;
}

/** mock Measurer：正文区子块合成高度 ≤ contentHeight 即放得下 */
function mockMeasurer(contentHeight: number): Measurer {
  return {
    fits(body) {
      let h = 0;
      for (const child of Array.from(body.children)) h += blockHeight(child as HTMLElement);
      return h <= contentHeight + 0.5;
    },
  };
}

/** 页高 height、四边 padding 20 → 正文高 height-40 */
function run(md: string, pageHeight: number) {
  const ir = parseToIR(md);
  return paginate(ir, {
    theme: 'modi',
    page: { width: 320, height: pageHeight, padding: 20 },
    measurer: mockMeasurer(pageHeight - 40),
  });
}

function pageBodies(pages: HTMLElement[]): HTMLElement[] {
  return pages.map((p) => {
    const body = p.querySelector('.mdcore-page-body');
    expect(body).not.toBeNull();
    return body as HTMLElement;
  });
}

describe('paginate：块级分页', () => {
  it('块不超页高不拆', () => {
    // 正文高 260，两段各 40 字 = 80px，合计 160px 放得下
    const pages = run(`${'一'.repeat(40)}\n\n${'二'.repeat(40)}\n`, 300);
    expect(pages.length).toBe(1);
    const [body] = pageBodies(pages);
    expect(body.children.length).toBe(2);
    expect(body.querySelector('.mdcore-split')).toBeNull();
    expect(body.children[0].textContent).toBe('一'.repeat(40));
    expect(body.children[1].textContent).toBe('二'.repeat(40));
  });

  it('超高段落用 Range 二分断点，拆分后文本守恒', () => {
    // 正文高 100 → 5 行 → 最多 50 字；段落 100 字必拆成 50 + 50
    const text = '一二三四五六七八九十'.repeat(10);
    const pages = run(text, 140);
    expect(pages.length).toBe(2);
    const bodies = pageBodies(pages);
    expect(bodies[0].children[0].textContent).toBe(text.slice(0, 50));
    expect(bodies[1].children[0].textContent).toBe(text.slice(50));
  });

  it('断点落在行内格式里时，两侧都保留格式标签', () => {
    // 40 字前缀 + 70 字 strong + 40 字后缀，断点 50 落在 strong 内部
    const md = `${'一'.repeat(40)}**${'粗'.repeat(70)}**${'后'.repeat(40)}`;
    const pages = run(md, 140);
    expect(pages.length).toBeGreaterThanOrEqual(2);
    const bodies = pageBodies(pages);
    expect(bodies[0].querySelector('strong')).not.toBeNull();
    expect(bodies[1].querySelector('strong')).not.toBeNull();
    const joined = bodies.map((b) => b.textContent).join('');
    expect(joined).toBe(`${'一'.repeat(40)}${'粗'.repeat(70)}${'后'.repeat(40)}`);
  });

  it('整页放不下的不可拆块硬放（不丢内容）', () => {
    // 图片 60px > 正文高 50px，且图片不可拆
    const pages = run(`![猫](https://example.com/cat.png)`, 90);
    expect(pages.length).toBe(1);
    expect(pageBodies(pages)[0].querySelector('img')).not.toBeNull();
  });
});

describe('paginate：表格按行拆', () => {
  it('跨页时下页自动重复表头', () => {
    // 正文高 120 → 表头 20 + 每行 20 → 首页放表头+5 行
    const rows = Array.from({ length: 10 }, (_, i) => `| c${i} | d${i} |`).join('\n');
    const md = `| 名称 | 值 |\n| --- | --- |\n${rows}`;
    const pages = run(md, 160);
    expect(pages.length).toBe(2);
    const bodies = pageBodies(pages);
    const t1 = bodies[0].querySelector('table');
    const t2 = bodies[1].querySelector('table');
    expect(t1).not.toBeNull();
    expect(t2).not.toBeNull();
    expect(t1!.querySelectorAll('tbody tr').length).toBe(5);
    // 变异点：下页必须带重复表头
    expect(t2!.querySelector('thead')).not.toBeNull();
    expect(t2!.querySelector('thead th')?.textContent).toBe('名称');
    expect(t2!.querySelectorAll('tbody tr').length).toBe(5);
    // 行内容守恒
    const allRows = [...t1!.querySelectorAll('tbody tr'), ...t2!.querySelectorAll('tbody tr')].map(
      (tr) => tr.textContent,
    );
    expect(allRows).toEqual(rows.split('\n').map((_, i) => `c${i}d${i}`));
  });
});

describe('paginate：强制分页边界（画布拖动边界写回的通道）', () => {
  const md = `${'一'.repeat(40)}\n\n${'二'.repeat(40)}\n\n${'三'.repeat(40)}`;

  function runWithBreaks(pageHeight: number, breaks: number[]) {
    const ir = parseToIR(md);
    return paginate(ir, {
      theme: 'modi',
      page: { width: 320, height: pageHeight, padding: 20 },
      measurer: mockMeasurer(pageHeight - 40),
      breaks,
    });
  }

  it('没有 breaks 时三段并一页；breaks=[2] 在第三块前收页', () => {
    // 正文高 260：3 段 × 40px = 120px，不强制时只有一页
    expect(runWithBreaks(300, []).length).toBe(1);
    const pages = runWithBreaks(300, [2]);
    expect(pages.length).toBe(2);
    const bodies = pageBodies(pages);
    expect(bodies[0].children.length).toBe(2);
    expect(bodies[1].children[0].textContent).toBe('三'.repeat(40));
  });

  it('强制边界不裁内容：收页后仍放不下的部分继续拆到后续页（字数守恒）', () => {
    // 正文高 100 → 5 行；强制在第 2 块前收页，而第 2 块自己就装不下 → 必须继续拆
    const pages = runWithBreaks(140, [1]);
    expect(pages.length).toBeGreaterThan(1);
    const bodies = pageBodies(pages);
    expect(bodies[0].children[0].textContent).toBe('一'.repeat(40));
    const rest = pages
      .slice(1)
      .map((p) => (p.querySelector('.mdcore-page-body') as HTMLElement).textContent ?? '')
      .join('');
    expect(rest).toBe('二'.repeat(40) + '三'.repeat(40));
  });

  it('breaks 里的 0 / 负数 / 非整数 / 越界值不会凭空多出空页', () => {
    for (const breaks of [[0], [-1], [1.5], [999]]) {
      const pages = runWithBreaks(300, breaks);
      expect(pages.length, `breaks=${JSON.stringify(breaks)}`).toBe(1);
      expect(pageBodies(pages)[0].children.length).toBe(3);
    }
  });
});

describe('paginate：新结构回归（v0.36 渲染层改造）', () => {
  it('超高代码块被卡片壳包住后仍能拆分、文本守恒（结构改动曾让整块消失）', () => {
    // v0.36 起 `pre` 被包进 .mdcore-code 卡片壳（挂圆角与语言标签）。若拆分逻辑
    // 只认顶层 pre，textBox 会返回 null → splitText 走 `el.remove()` → **整段代码
    // 从产物里消失**（分页数还是对的，只有内容没了，jsdom 不看内容就看不出来）。
    const code = Array.from({ length: 30 }, (_, i) => `line-${i}`).join('\n');
    const pages = run(`\`\`\`ts\n${code}\n\`\`\`\n`, 260);
    expect(pages.length).toBeGreaterThan(1);
    const joined = pageBodies(pages)
      .map((b) => Array.from(b.children).map((c) => c.querySelector('code')?.textContent ?? '').join(''))
      .join('');
    expect(joined.replace(/\s+/g, ' ').trim()).toBe(code.replace(/\s+/g, ' '));
    // 续页不再重复一遍语言标签（它是"从哪开始"的标记，不是内容）
    expect(pages.slice(1).every((page) => page.querySelector('.mdcore-code-head') === null)).toBe(true);
  });

  it('断点二分不切进装饰节点（章节序号/引用大引号不是正文）', () => {
    // 装饰文字如果进了 textIndex，断点可能落在 “ 里，下一页开头挂一个孤引号
    const md = '> ' + '字'.repeat(120);
    const pages = run(md, 100);
    const bodies = pageBodies(pages);
    for (const body of bodies.slice(1)) {
      expect(body.textContent?.startsWith('“')).toBe(false);
    }
    expect(bodies.map((b) => b.textContent ?? '').join('')).toBe('字'.repeat(120));
  });
});

describe('paginate：孤行控制', () => {
  it('标题不留页尾，与它后第一块绑定推下页', () => {
    // 正文高 100：para 40px + h2 40px = 80px 放得下；再追加 60px 图片放不下的时刻，
    // h2 成了页尾孤行，应随图片一起挪到下页
    const md = `${'一'.repeat(20)}\n\n## 小节标题\n\n![图](https://example.com/a.png)`;
    const pages = run(md, 140);
    expect(pages.length).toBe(2);
    const bodies = pageBodies(pages);
    expect(bodies[0].children.length).toBe(1);
    expect(bodies[0].children[0].tagName).toBe('P');
    expect(bodies[1].children[0].tagName).toBe('H2');
    expect(bodies[1].children[0].textContent).toBe('小节标题');
    expect(bodies[1].querySelector('img')).not.toBeNull();
  });
});

describe('paginate：断行规则（避头尾 / 不拆词）', () => {
  it('闭标点不开行首：断点回退', () => {
    // 正文高 60 → 3 行 → 断点 k=30，恰落在 '，' 前；避头规则回退到 29，
    // 余部 30 字（一，+ 二×28）恰好再占一页
    const text = `${'一'.repeat(30)}，${'二'.repeat(28)}`;
    const pages = run(text, 100);
    expect(pages.length).toBe(2);
    const bodies = pageBodies(pages);
    expect(bodies[1].children[0].textContent?.startsWith('，')).toBe(false);
    expect(bodies[0].children[0].textContent).toBe('一'.repeat(29));
    expect(bodies[1].children[0].textContent).toBe(`一，${'二'.repeat(28)}`);
  });

  it('英文单词不被拆：断点退到词首空格', () => {
    const text = `${'a'.repeat(15)} ${'b'.repeat(30)}`;
    const pages = run(text, 100); // k=30 落在 b 串中间
    expect(pages.length).toBe(2);
    const bodies = pageBodies(pages);
    expect(bodies[1].children[0].textContent).toBe('b'.repeat(30));
    expect(bodies[0].children[0].textContent?.trim()).toBe('a'.repeat(15));
  });

  it('adjustBreak：下一页不以标点开头（移植样例）', () => {
    const text = '今天天气很好，我们去公园';
    const k = text.indexOf('，');
    expect(adjustBreak(text, k)).toBe(k - 1);
  });

  it('adjustBreak：不把英文单词拦腰截断（移植样例）', () => {
    const text = '我喜欢 JavaScript 语言';
    const k = text.indexOf('Script');
    expect(adjustBreak(text, k)).toBe(text.indexOf('Java'));
  });

  it('adjustBreak：前一页不以左括号结尾（移植样例）', () => {
    const text = '这是一个「引号」例子';
    const k = text.indexOf('引');
    expect(adjustBreak(text, k)).toBe(k - 1);
  });

  it('codeBreak：代码块尽量在换行处断开', () => {
    const text = 'ab\ncd\nef';
    expect(codeBreak(text, 4)).toBe(3);
    expect(codeBreak(text, 8)).toBe(6);
  });
});
