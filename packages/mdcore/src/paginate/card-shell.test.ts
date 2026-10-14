/**
 * 页壳分层与强制分页的判据（切片 2）。
 *
 * 三条要守住的：
 * ①五层（底纹/装饰/页眉/正文/页脚）齐备，且**只有正文层进测量流**；
 * ②装饰件加高 999px 不得改变分页结果——这是"装饰不进测量流"的唯一硬证据；
 * ③`---` 在卡片平台是强制分页，在连续长文里仍是一条横线（不能为了卡片改掉长文）。
 */
import { describe, expect, it } from 'vitest';

import {
  applyTheme,
  paginate,
  parseToIR,
  xhsCards,
  type Measurer,
} from '../index';

/**
 * 合成测量器：每块 100px，页内容区容量 200px（可容 2 块）。
 *
 * 为什么用合成测量器而不是真布局：jsdom 没有排版，`getBoundingClientRect` 恒为 0，
 * 真测量器在测试里永远返回"放得下"，分页逻辑一条都测不到。
 */
const unit: Measurer = {
  fits(body) {
    return body.children.length * 100 <= 200;
  },
};

/** 容量 4 块的测量器：用来构造"自然分页不会拆、只有强制分页才会拆"的场景 */
const roomy: Measurer = {
  fits(body) {
    return body.children.length * 100 <= 400;
  },
};

function cardsWith(md: string, measurer: Measurer, chrome?: Parameters<typeof paginate>[1]['chrome']) {
  return paginate(parseToIR(md), {
    theme: 'taoyao',
    page: { width: 600, height: 400, padding: 20 },
    measurer,
    doc: globalThis.document,
    chrome,
  });
}

const LONG = Array.from({ length: 7 }, (_, i) => `第 ${i + 1} 段`).join('\n\n');

function cards(md: string, chrome?: Parameters<typeof paginate>[1]['chrome']) {
  return paginate(parseToIR(md), {
    theme: 'taoyao',
    page: { width: 600, height: 400, padding: 20 },
    measurer: unit,
    doc: globalThis.document,
    chrome,
  });
}

describe('五层页壳', () => {
  it('底纹/装饰/页眉/正文/页脚各就各位，正文层在页眉之后、页脚之前', () => {
    const [page] = cards('一段正文', {
      header: '排版工坊',
      watermark: '@我的小红书号',
      bgColor: '#fffdf7',
      deco: [{ html: '<i class="tape"></i>', anchor: 'top', span: 30 }],
    });
    const classes = Array.from(page.children).map((el) => el.className);
    expect(classes).toEqual([
      'mdcore-card-bg',
      'mdcore-card-deco',
      'mdcore-card-header',
      'mdcore-page-body',
      'mdcore-card-footer',
    ]);
    expect(page.querySelector('.mdcore-card-header')?.textContent).toBe('排版工坊');
    expect(page.querySelector('.mdcore-card-watermark')?.textContent).toBe('@我的小红书号');
  });

  it('不给 chrome 时就是纯页壳（微信/知乎长文不受影响）', () => {
    const [page] = cards('一段正文');
    expect(Array.from(page.children).map((el) => el.className)).toEqual(['mdcore-page-body']);
  });

  it('页码可以关掉（关掉后页脚里没有页码槽）', () => {
    const [on] = cards('一段正文', { watermark: '署名', pageNum: true });
    const [off] = cards('一段正文', { watermark: '署名', pageNum: false });
    expect(on.querySelector('.mdcore-card-pageno')).toBeTruthy();
    expect(off.querySelector('.mdcore-card-pageno')).toBeNull();
  });

  it('正文层里只有内容块：装饰/页眉/页脚都不许挂进 body', () => {
    const [page] = cards('一段正文', {
      bgColor: '#fff',
      header: '页眉',
      watermark: '署名',
      deco: [{ html: '<i></i>', anchor: 'top' }],
    });
    const body = page.querySelector('.mdcore-page-body') as HTMLElement;
    const inBody = Array.from(body.children).map((el) => el.tagName);
    expect(inBody).toEqual(['P']);
    expect(body.querySelector('.mdcore-card-deco')).toBeNull();
    expect(body.querySelector('.mdcore-card-header')).toBeNull();
    expect(body.querySelector('.mdcore-card-footer')).toBeNull();
  });

  it('页壳分列 + 正文层是伸缩项（页眉页脚占内容区之外的留白）', () => {
    const [page] = cards('一段正文', { header: '页眉' });
    expect(page.style.display).toBe('flex');
    expect(page.style.flexDirection).toBe('column');
    const body = page.querySelector('.mdcore-page-body') as HTMLElement;
    expect(body.style.flex).toBe('1 1 auto');
  });

  it('装饰层全部绝对定位（不进正文流）', () => {
    const [page] = cards('一段正文', {
      bgColor: '#fff',
      deco: [
        { html: '<i></i>', anchor: 'top' },
        { html: '<i></i>', anchor: 'bottom', align: 'end' },
      ],
    });
    for (const deco of Array.from(page.querySelectorAll('.mdcore-card-deco'))) {
      expect((deco as HTMLElement).style.position).toBe('absolute');
    }
    // 底纹同理
    expect((page.querySelector('.mdcore-card-bg') as HTMLElement).style.position).toBe('absolute');
  });
});

describe('装饰不进测量流（硬证据）', () => {
  it('装饰层高度撑到 999px，分页结果一字不变', () => {
    const plain = cards(LONG).map((p) => p.querySelectorAll('.mdcore-page-body > *').length);
    const decorated = cards(LONG, {
      bgColor: '#fff',
      deco: Array.from({ length: 5 }, (_, i) => ({
        html: `<div style="height:${i * 7 + 300}px">装饰</div>`,
        anchor: 'top' as const,
      })),
      header: '页眉',
    }).map((p) => p.querySelectorAll('.mdcore-page-body > *').length);
    expect(decorated).toEqual(plain);
  });

  it('页眉加高也不改变分页', () => {
    const withHeader = cards(LONG, { header: '很长的页眉文字'.repeat(20) }).map(
      (p) => p.querySelectorAll('.mdcore-page-body > *').length,
    );
    expect(withHeader).toEqual(cards(LONG).map((p) => p.querySelectorAll('.mdcore-page-body > *').length));
  });
});

describe('--- 强制分页', () => {
  /**
   * 判据的关键在「本来放得下」：容量 4 块、内容 3 块（含那条 `---`），
   * 不强制分页的话就只有一页。写成"内容多到自然会拆"的话，断言照样通过，
   * 却什么都没验——第一次跑就是这么被骗过去的。
   */
  it('`---` 强制收页：本来一页放得下的稿子被切成两页', () => {
    const pages = cardsWith('甲\n\n---\n\n乙', roomy);
    expect(pages).toHaveLength(2);
    expect(pages[0].querySelector('.mdcore-page-body')?.textContent).toBe('甲');
    expect(pages[1].querySelector('.mdcore-page-body')?.textContent).toBe('乙');
  });

  it('`---` 自己不出现在任何一页里', () => {
    const pages = cards('甲\n\n---\n\n乙\n\n丙\n\n丁');
    const texts = pages.map((p) => p.querySelector('.mdcore-page-body')?.textContent ?? '');
    expect(texts.join('')).not.toContain('---');
    for (const page of pages) expect(page.querySelector('[data-mdcore-pagebreak]')).toBeNull();
  });

  it('页内还没内容时不收页（开头就一个 `---` 不会凭空多一张空卡）', () => {
    const pages = cardsWith('---\n\n甲', roomy);
    expect(pages).toHaveLength(1);
    expect(pages[0].querySelector('.mdcore-page-body')?.textContent).toContain('甲');
  });

  it('`***` 是分隔线不是分页（两个平台都得留着那条线）', () => {
    const pages = cards('甲\n\n***');
    expect(pages).toHaveLength(1);
    // 主题 hrStyle 是 dots 时渲染的是三圆点 section 而不是 <hr>，两者都不带分页标记
    const rule = pages[0].querySelector('hr') ?? pages[0].querySelector('.mdcore-hr-dots');
    expect(rule).toBeTruthy();
    expect(pages[0].querySelector('[data-mdcore-pagebreak]')).toBeNull();
  });

  it('长文（微信/知乎）里 `---` 仍然是一条横线：不能为了卡片改掉长文', () => {
    const el = applyTheme(parseToIR('甲\n\n---\n\n乙'), 'modi');
    const hr = el.querySelector('hr') as HTMLElement;
    expect(hr).toBeTruthy();
    // 但它带上了"可被卡片平台翻成分页"的标记
    expect(hr.getAttribute('data-mdcore-pagebreak')).toBe('true');
  });

  it('卡片平台：带标记的横线被翻成分页，横线本身不进卡片', () => {
    const result = xhsCards(parseToIR('甲\n\n---\n\n乙'), {
      measurer: roomy,
      doc: globalThis.document,
      cover: false,
    });
    expect(result.pageCount).toBe(2);
    expect(result.pages[0].querySelector('[data-mdcore-pagebreak]')).toBeNull();
  });

  /**
   * 回归：小红书三套主题的 hrStyle 都是 dots，走的是三圆点分支。
   * 早先把分页标记只加在 <hr> 分支上，于是 `---` 在小红书上**静默失效**——
   * 作者以为划了页，实际仍然连在一起（"完全不可用"清单里没被单列出来的一条）。
   */
  it('dots 样式的横线同样带分页标记（三套小红书主题都走这条分支）', () => {
    const el = applyTheme(parseToIR('甲\n\n---\n\n乙'), 'taoyao');
    const rule = el.querySelector('[data-mdcore-pagebreak]');
    expect(rule).toBeTruthy();
    expect(rule?.className).toContain('mdcore-hr-dots');
  });

  it('强制分页不裁内容（字数守恒）：`---` 前后文字一个不少', () => {
    const pages = cards(LONG + '\n\n---\n\n尾段甲\n\n尾段乙');
    const all = pages.map((p) => p.querySelector('.mdcore-page-body')?.textContent ?? '').join('');
    for (const i of [1, 5, 7]) expect(all).toContain(`第 ${i} 段`);
    expect(all).toContain('尾段甲');
    expect(all).toContain('尾段乙');
  });
});