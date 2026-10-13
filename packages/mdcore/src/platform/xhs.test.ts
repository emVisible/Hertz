import { describe, expect, it } from 'vitest';
import { getTheme, listThemes, parseToIR, XHS_CARD, XHS_MAX_PAGES, xhsCaption, xhsCards } from '../index';
import type { Measurer } from '../index';

/** xhs 卡片内容高 = 卡高 - 上 padding - (下 padding + 页脚区) */
const CONTENT_H = XHS_CARD.height - XHS_CARD.padding * 2 - XHS_CARD.footerSpace;

const LINE_H = 20;
const CPL = 10;

function blockHeight(el: HTMLElement): number {
  if (el.matches('h1,h2,h3,h4,h5,h6')) return 40;
  const len = (el.textContent ?? '').length;
  return Math.max(1, Math.ceil(len / CPL)) * LINE_H;
}

function mockMeasurer(contentHeight: number): Measurer {
  return {
    fits(body) {
      let h = 0;
      for (const child of Array.from(body.children)) h += blockHeight(child as HTMLElement);
      return h <= contentHeight + 0.5;
    },
  };
}

describe('xhs 主题', () => {
  it('注册 4 套 platform=xhs 主题（3 亮 + 1 深色「夜航」），且带卡片/页脚位样式', () => {
    const xhsThemes = listThemes().filter((t) => t.platform === 'xhs');
    expect(xhsThemes.length).toBe(4);
    expect(xhsThemes.filter((t) => t.dark === true).map((t) => t.id)).toEqual(['yehang']);
    for (const { id } of xhsThemes) {
      const theme = getTheme(id);
      expect(theme.styles.card).toBeTruthy();
      expect(theme.styles.cardFooter).toBeTruthy();
    }
  });
});

describe('xhsCards', () => {
  it('首块是 heading → 第一页做成封面页', () => {
    const ir = parseToIR('# 大标题\n\n正文内容。');
    const { pages, overflow } = xhsCards(ir, { measurer: mockMeasurer(CONTENT_H) });
    expect(overflow).toBe(false);
    expect(pages.length).toBe(1);
    const cover = pages[0];
    expect(cover.dataset.cover).toBe('true');
    const h1 = cover.querySelector('h1') as HTMLElement;
    expect(h1.style.textAlign).toBe('center');
    // 封面标题放大：大于主题 h1 基础字号
    const base = parseFloat(getTheme('taoyao').styles.h1['font-size']);
    expect(parseFloat(h1.style.fontSize)).toBeGreaterThan(base);
  });

  it('首块不是 heading → 不做封面页', () => {
    const ir = parseToIR('开门见山的正文。');
    const { pages } = xhsCards(ir, { measurer: mockMeasurer(CONTENT_H) });
    expect(pages[0].dataset.cover).toBeUndefined();
  });

  it('18 页上限：19 页输入 → overflow:true 且不静默截断', () => {
    // 每段 700 字 = 1400px，一页只放得下一整段 → 19 段 = 19 页
    const md = Array.from({ length: 19 }, () => '字'.repeat(700)).join('\n\n');
    const { pages, overflow, suggestion, pageCount } = xhsCards(parseToIR(md), {
      measurer: mockMeasurer(CONTENT_H),
    });
    expect(pageCount).toBe(19);
    expect(pages.length).toBe(19); // 不截断
    expect(overflow).toBe(true);
    expect(suggestion).toBeTruthy();
    expect(suggestion).toContain(String(XHS_MAX_PAGES));
  });

  it('品牌页脚：每页含署名与页码', () => {
    const md = Array.from({ length: 3 }, () => '字'.repeat(700)).join('\n\n');
    const { pages } = xhsCards(parseToIR(md), {
      footer: 'young 的笔记',
      measurer: mockMeasurer(CONTENT_H),
    });
    expect(pages.length).toBe(3);
    pages.forEach((page, i) => {
      const footer = page.querySelector('.mdcore-xhs-footer');
      expect(footer).not.toBeNull();
      expect(footer!.textContent).toContain('young 的笔记');
      expect(footer!.textContent).toContain(`${i + 1} / 3`);
    });
  });

  it('品牌二维码位：qr 传入时每页页脚渲染 eager img，不传则无', () => {
    const md = '正文一。\n\n正文二。';
    const withQr = xhsCards(parseToIR(md), {
      footer: 'young',
      qr: 'data:image/png;base64,AAAA',
      measurer: mockMeasurer(CONTENT_H),
    });
    const withoutQr = xhsCards(parseToIR(md), { footer: 'young', measurer: mockMeasurer(CONTENT_H) });
    withQr.pages.forEach((page) => {
      const img = page.querySelector('.mdcore-xhs-footer-qr');
      expect(img).not.toBeNull();
      expect(img!.getAttribute('src')).toBe('data:image/png;base64,AAAA');
      expect(img!.getAttribute('loading')).toBe('eager');
    });
    expect(withoutQr.pages[0].querySelector('.mdcore-xhs-footer-qr')).toBeNull();
  });


  it('卡片容器按 3:4 页尺寸挂样式', () => {
    const ir = parseToIR('正文。');
    const { pages } = xhsCards(ir, { measurer: mockMeasurer(CONTENT_H) });
    expect(pages[0].style.width).toBe(`${XHS_CARD.width}px`);
    expect(pages[0].style.height).toBe(`${XHS_CARD.height}px`);
  });
});

describe('xhsCaption', () => {
  it('含标题、正文与 # 话题占位', () => {
    const ir = parseToIR('# 探店报告\n\n这家咖啡很不错。\n\n- 手冲\n-  dirty\n');
    const caption = xhsCaption(ir);
    expect(caption).toContain('探店报告');
    expect(caption).toContain('这家咖啡很不错。');
    expect(caption).toContain('手冲');
    expect(caption.endsWith('#')).toBe(true);
  });

  it('给定话题时尾部是 #话题 列表', () => {
    const ir = parseToIR('# 标题\n\n正文。');
    const caption = xhsCaption(ir, { topics: ['咖啡', '周末'] });
    expect(caption.endsWith('#咖啡 #周末')).toBe(true);
  });
});
