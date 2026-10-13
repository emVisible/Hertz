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
  if (el.matches('table')) {
    const head = el.querySelector('thead') ? 1 : 0;
    return (head + el.querySelectorAll('tbody tr').length) * LINE_H;
  }
  if (el.matches('pre')) return (el.textContent ?? '').split('\n').length * LINE_H;
  if (el.matches('img')) return IMG_H;
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
