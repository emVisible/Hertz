import { describe, expect, it } from 'vitest';
import { getTheme, listThemes, parseToIR, XHS_CARD, XHS_MAX_PAGES, xhsCaption, xhsCards } from '../index';
import type { Measurer } from '../index';

/** xhs 卡片内容高 = 卡高 - 上 padding - (下 padding + 页脚区) */
const CONTENT_H = XHS_CARD.height - XHS_CARD.padding * 2 - XHS_CARD.footerSpace;

const LINE_H = 20;
const CPL = 10;

function blockHeight(el: HTMLElement): number {
  if (el.matches('h1,h2,h3,h4,h5,h6')) return 40;
  // v0.36：代码块套了卡片壳（图注也会带进 textContent），按代码本体算行数
  const code = el.querySelector('code');
  const body = code ? code.textContent ?? '' : el.textContent ?? '';
  return Math.max(1, Math.ceil(body.length / CPL)) * LINE_H;
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
  it('封面标题字号自适应：短标题放大到放不下为止（绝对 px，不做 em×倍数）', () => {
    const { pages } = xhsCards(parseToIR('# 短标题\n\n正文。'), { measurer: mockMeasurer(CONTENT_H) });
    const title = pages[0].querySelector('.mdcore-cover-title') as HTMLElement;
    // 固定倍数 ×1.5 是拍脑袋的：短标题放大后仍留大片空白，长标题放大后被裁。
    // 现在是测量台上二分出来的「尽量大但放得下」，所以必须是实打实的 px
    expect(title.style.fontSize).toMatch(/^\d+px$/);
    expect(parseFloat(title.style.fontSize)).toBeGreaterThan(
      parseFloat(getTheme('taoyao').tokens.fontSize) * 1.5,
    );
  });

  it('首块是 heading → 生成一张**独立封面页**，正文页整体后移', () => {
    const { pages, overflow } = xhsCards(parseToIR('# 大标题\n\n正文内容。'), {
      measurer: mockMeasurer(CONTENT_H),
    });
    expect(overflow).toBe(false);
    expect(pages).toHaveLength(2);
    expect(pages[0].dataset.cover).toBe('true');
    // 封面页只有封面块，没有正文
    expect(pages[0].querySelector('.mdcore-cover')).toBeTruthy();
    expect(pages[1].querySelector('.mdcore-cover')).toBeNull();
  });

  it('标题块从正文流里摘掉：不在封面重复出现，也不在正文页再出现一次', () => {
    const { pages } = xhsCards(parseToIR('# 大标题\n\n正文内容。'), { measurer: mockMeasurer(CONTENT_H) });
    expect(pages[0].textContent).toContain('大标题');
    expect(pages[1].querySelector('h1')).toBeNull();
    expect(pages[1].textContent).not.toContain('大标题');
  });

  it('首块不是 heading → 不做封面页', () => {
    const { pages } = xhsCards(parseToIR('开门见山的正文。'), { measurer: mockMeasurer(CONTENT_H) });
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
      const footer = page.querySelector('.mdcore-card-footer');
      expect(footer).not.toBeNull();
      expect(footer!.textContent).toContain('young 的笔记');
      expect(footer!.textContent).toContain(`${i + 1} / 3`);
    });
  });

  it('breaks 透传：强制边界在第三块前收页（画布拖过的边界要真的落到卡片上）', () => {
    // 三段各 700 字，一页只放得下一段 → 自然分页本就是 3 页；
    // 强制边界 [1] 会让第一页只放第一段、第二页从第二段开始（页数不变、边界位置变）
    const md = Array.from({ length: 3 }, () => '字'.repeat(700)).join('\n\n');
    const natural = xhsCards(parseToIR(md), { measurer: mockMeasurer(CONTENT_H) });
    expect(natural.pageCount).toBe(3);
    const forced = xhsCards(parseToIR(md), { measurer: mockMeasurer(CONTENT_H), breaks: [1] });
    expect(forced.pageCount).toBe(3);
    const second = forced.pages[1].querySelector('.mdcore-page-body') as HTMLElement;
    expect(second.firstElementChild?.getAttribute('data-mdcore-block')).toBe('1');
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

describe('页壳基线字体（真浏览器抓出的缺陷）', () => {
  it('卡片必须带主题基线字号/行距，否则正文退回浏览器默认 16px', () => {
    const { pages } = xhsCards(parseToIR('正文。'), {
      theme: 'taoyao',
      measurer: mockMeasurer(CONTENT_H),
    });
    expect(pages[0].style.fontSize).toBe('30px');
    expect(pages[0].style.lineHeight).toBe('1.55');
    expect(pages[0].style.fontFamily).toContain('PingFang SC');
  });

  it('overrides.fontSize 同样落到页壳（右栏字号档对卡片生效）', () => {
    const { pages } = xhsCards(parseToIR('正文。'), {
      theme: 'taoyao',
      overrides: { fontSize: '36px' },
      measurer: mockMeasurer(CONTENT_H),
    });
    expect(pages[0].style.fontSize).toBe('36px');
  });
});

describe('封面独立页（切片 3：溢出/截断的根因修复）', () => {
  const roomy = () => mockMeasurer(XHS_CARD.height); // 一页装得下，用来暴露"本来不会拆"的场景

  it('封面页不排页码，正文页页码从 1 开始、总页数含封面', () => {
    const { pages } = xhsCards(parseToIR('# 标题\n\n甲\n\n乙\n\n丙'), { measurer: mockMeasurer(CONTENT_H) });
    expect(pages.length).toBeGreaterThan(1);
    expect(pages[0].querySelector('.mdcore-card-pageno')).toBeNull();
    const nums = pages.slice(1).map((p) => p.querySelector('.mdcore-card-pageno')?.textContent);
    expect(nums[0]).toBe(`1 / ${pages.length}`);
    expect(nums[nums.length - 1]).toBe(`${pages.length - 1} / ${pages.length}`);
  });

  it('封面带角标、副标题，字段缺失时就不出现（不留空气节点）', () => {
    const plain = xhsCards(parseToIR('# 标题\n\n正文。'), { measurer: mockMeasurer(CONTENT_H) });
    expect(plain.pages[0].querySelector('.mdcore-cover-badge')).toBeNull();
    expect(plain.pages[0].querySelector('.mdcore-cover-sub')).toBeNull();

    const rich = xhsCards(parseToIR('# 标题\n\n正文。'), {
      measurer: mockMeasurer(CONTENT_H),
      coverBadge: '建议收藏',
      coverSubtitle: '看完能少走半年弯路',
    });
    expect(rich.pages[0].querySelector('.mdcore-cover-badge')?.textContent).toBe('建议收藏');
    expect(rich.pages[0].querySelector('.mdcore-cover-sub')?.textContent).toBe('看完能少走半年弯路');
  });

  it('封面标题可覆盖：不写就用正文第一个 H1', () => {
    const fromDoc = xhsCards(parseToIR('# 正文里的标题\n\n正文。'), { measurer: mockMeasurer(CONTENT_H) });
    expect(fromDoc.pages[0].querySelector('.mdcore-cover-title')?.textContent).toBe('正文里的标题');

    const custom = xhsCards(parseToIR('# 正文里的标题\n\n正文。'), {
      measurer: mockMeasurer(CONTENT_H),
      coverTitle: '另一个标题',
    });
    expect(custom.pages[0].querySelector('.mdcore-cover-title')?.textContent).toBe('另一个标题');
    // 正文里的原标题仍在正文页上：封面换标题不该动作者的内容
    expect(custom.pages[1].textContent).toContain('正文里的标题');
  });

  it('显式关闭封面时不产生封面页（pageCount 与正文页数一致）', () => {
    const { pages } = xhsCards(parseToIR('# 标题\n\n正文。'), {
      measurer: mockMeasurer(CONTENT_H),
      cover: false,
    });
    expect(pages).toHaveLength(1);
    expect(pages[0].querySelector('.mdcore-cover')).toBeNull();
  });

  it('**字号自适应是真的在二分**：测量台测量的是克隆件，真实封面内容不搬家', () => {
    const { pages } = xhsCards(parseToIR('# 三\n\n正文。'), { measurer: mockMeasurer(CONTENT_H) });
    const cover = pages[0];
    // 封面内容必须还在页里（第一版用 replaceChildren(wrap) 搬运真节点，量完被一起带走）
    expect(cover.textContent).toContain('三');
    expect(cover.querySelector('.mdcore-cover-title')).toBeTruthy();
    // 测量台用完即摘，不能留在文档里
    expect(document.querySelectorAll('.mdcore-measure-stage').length).toBe(0);
  });

  it('封面页与正文页同规格（同宽高同边距），不是另写一套样式', () => {
    const { pages } = xhsCards(parseToIR('# 标题\n\n正文。'), { measurer: mockMeasurer(CONTENT_H) });
    const coverStyle = pages[0].getAttribute('style') ?? '';
    const bodyStyle = pages[1].getAttribute('style') ?? '';
    for (const key of ['width:', 'height:', 'padding:', 'background-color:']) {
      expect(coverStyle).toContain(key);
      expect(bodyStyle).toContain(key);
    }
  });
});
