/**
 * 小红书适配器（§3.3）：3:4（1242×1656）测量分页卡片。
 *  - 自动封面：第一页首块是 heading 则放大居中做成封面页
 *  - 品牌页脚：每页底部页码 + 可配置署名（footer）
 *  - 18 页上限：超出返回 overflow:true 与建议，不静默截断
 *  - 文案导出 xhsCaption：纯文本（标题+正文+尾部话题标签位），供复制。不做直发。
 */
import type { InlineNode, IRBlock, LayoutIR } from '../ir/types';
import { paginate } from '../paginate/paginate';
import type { Measurer } from '../paginate/paginate';
import { resolveThemedProps } from '../theme/apply';
import { defaultThemeFor, resolveTheme } from '../theme/index';
import type { Theme, ThemeOverrides } from '../theme/types';

/** 3:4 卡片尺寸与页脚预留（px，导出坐标系） */
export const XHS_CARD = {
  width: 1242,
  height: 1656,
  padding: 72,
  /** 下 padding 之外的页脚预留区 */
  footerSpace: 84,
} as const;

/** 小红书单篇图集页数上限 */
export const XHS_MAX_PAGES = 18;

/** 带二维码时页脚预留加宽（88px 图 + 上下留白） */
const QR_FOOTER_SPACE = 128;
const QR_SIZE = '88px';

export interface XhsOptions {
  /** 缺省用第一套 platform=xhs 的内置主题（桃夭） */
  theme?: Theme | string;
  overrides?: ThemeOverrides;
  /** 品牌页脚署名 */
  footer?: string;
  /** 品牌二维码（dataURL 或同源 URL），渲染在页脚右侧并加宽页脚预留区 */
  qr?: string | null;
  /** 缺省 true：首块是 heading 时第一页做封面 */
  cover?: boolean;
  /** 缺省 18 */
  maxPages?: number;
  /**
   * 强制分页边界（IR 块序号）：画布上手动拖过边界的位置。语义见 paginate 的
   * `breaks`——只增不减的「至少在这里断」，不裁内容。
   */
  breaks?: number[];
  /** 测试注入 mock 测量 */
  measurer?: Measurer;
  doc?: Document;
}

export interface XhsResult {
  pages: HTMLElement[];
  pageCount: number;
  overflow: boolean;
  /** overflow 时的精简/拆分建议 */
  suggestion?: string;
}

/** IR → 小红书卡片组（分页 + 封面 + 品牌页脚 + 上限提示） */
export function xhsCards(ir: LayoutIR, opts: XhsOptions = {}): XhsResult {
  const doc = opts.doc ?? globalThis.document;
  if (!doc) throw new Error('@hertz/mdcore: xhsCards 需要 DOM 环境（浏览器或 jsdom）');
  const theme = resolveTheme(opts.theme ?? defaultThemeFor('xhs'));
  const overrides = opts.overrides ?? {};

  const pages = paginate(ir, {
    theme,
    overrides,
    page: {
      width: XHS_CARD.width,
      height: XHS_CARD.height,
      padding: {
        top: XHS_CARD.padding,
        right: XHS_CARD.padding,
        bottom: XHS_CARD.padding + (opts.qr ? QR_FOOTER_SPACE : XHS_CARD.footerSpace),
        left: XHS_CARD.padding,
      },
    },
    measurer: opts.measurer,
    breaks: opts.breaks,
    doc,
  });

  if (opts.cover !== false && pages.length) applyCover(pages[0]);
  pages.forEach((page, i) => {
    page.appendChild(makeFooter(doc, theme, overrides, opts.footer, i, pages.length, opts.qr));
  });

  const max = opts.maxPages ?? XHS_MAX_PAGES;
  const overflow = pages.length > max;
  return {
    pages,
    pageCount: pages.length,
    overflow,
    suggestion: overflow
      ? `内容共 ${pages.length} 页，超出小红书 ${max} 页上限：建议精简内容，或拆分为 ${Math.ceil(pages.length / max)} 篇笔记。`
      : undefined,
  };
}

/** 封面标题放大倍数 */
const COVER_TITLE_SCALE = 1.5;

/**
 * 按倍数放大字号，**保留单位**。
 *
 * 这里的坑：v0.36 起标题字号是相对值（`1.7em`）。早先的实现是
 * `parseFloat(fontSize) * 1.5` 再拼 `px` —— `parseFloat('1.7em')` = 1.7，
 * 于是封面标题变成 **1.7 × 1.5 = 2.55px**：整张卡片最该抢眼的那行标题缩成一个点。
 * 结构层 158 条断言一条都没红，是排版基线图（`tests/baselines/typography/`）
 * 第一轮就抓出来的。
 */
export function scaleFontSize(current: string, factor: number): string {
  const value = current.trim();
  const m = /^(-?[\d.]+)(em|rem|px|%)?$/.exec(value);
  if (!m) return `${Math.round(54 * factor)}px`; // 取不到就用缺省 54px
  const num = parseFloat(m[1]);
  const unit = m[2] ?? 'px';
  const scaled = unit === 'px' ? `${Math.round(num * factor)}px` : `${+(num * factor).toFixed(3)}${unit}`;
  return scaled;
}

/** 自动封面：第一页首块是 heading → 放大居中 */
function applyCover(page: HTMLElement): void {
  const body = page.querySelector('.mdcore-page-body') as HTMLElement | null;
  const first = body?.firstElementChild as HTMLElement | null | undefined;
  if (!body || !first || !/^H[1-6]$/.test(first.tagName)) return;
  page.dataset.cover = 'true';
  body.style.setProperty('display', 'flex');
  body.style.setProperty('flex-direction', 'column');
  body.style.setProperty('justify-content', 'center');
  first.style.setProperty('font-size', scaleFontSize(first.style.fontSize, COVER_TITLE_SCALE));
  first.style.setProperty('text-align', 'center');
  first.style.setProperty('width', '100%');
}

/** 品牌页脚：署名 + 页码（+ 可选二维码），绝对定位在页脚预留区（不进测量流） */
function makeFooter(
  doc: Document,
  theme: Theme,
  overrides: ThemeOverrides,
  footerText: string | undefined,
  index: number,
  total: number,
  qr?: string | null,
): HTMLElement {
  const el = doc.createElement('div');
  el.className = 'mdcore-xhs-footer';
  el.style.setProperty('position', 'absolute');
  el.style.setProperty('left', `${XHS_CARD.padding}px`);
  el.style.setProperty('right', `${XHS_CARD.padding}px`);
  el.style.setProperty('bottom', '36px');
  el.style.setProperty('display', 'flex');
  el.style.setProperty('justify-content', 'space-between');
  el.style.setProperty('align-items', 'baseline');
  for (const [prop, value] of Object.entries(resolveThemedProps(theme, overrides, 'cardFooter'))) {
    el.style.setProperty(prop, value);
  }
  const brand = doc.createElement('span');
  brand.className = 'mdcore-xhs-footer-brand';
  brand.textContent = footerText ?? '';
  const num = doc.createElement('span');
  num.className = 'mdcore-xhs-footer-page';
  num.textContent = `${index + 1} / ${total}`;
  el.appendChild(brand);
  el.appendChild(num);
  if (qr) {
    const img = doc.createElement('img');
    img.setAttribute('src', qr);
    img.setAttribute('alt', '');
    img.setAttribute('loading', 'eager');
    img.className = 'mdcore-xhs-footer-qr';
    for (const [prop, value] of Object.entries({
      width: QR_SIZE,
      height: QR_SIZE,
      'object-fit': 'contain',
      'border-radius': '8px',
      'margin-left': '12px',
    })) {
      img.style.setProperty(prop, value);
    }
    el.appendChild(img);
  }
  return el;
}

/* ------------------------------------------------------------ 文案导出 */

export interface XhsCaptionOptions {
  /** 话题标签（不带 #）；缺省输出 '#' 占位位 */
  topics?: string[];
}

/** IR → 纯文本文案：标题 + 正文 + 尾部话题标签位，供复制到小红书发布框 */
export function xhsCaption(ir: LayoutIR, opts: XhsCaptionOptions = {}): string {
  const parts: string[] = [];
  for (const block of ir) {
    const text = blockText(block);
    if (text) parts.push(text);
  }
  const tags = opts.topics?.length ? opts.topics.map((t) => `#${t}`).join(' ') : '#';
  return `${parts.join('\n\n')}\n\n${tags}`;
}

function blockText(block: IRBlock): string {
  switch (block.type) {
    case 'heading':
    case 'para':
      return inlineText(block.children);
    case 'list':
      return block.items
        .map((item, i) => `${block.ordered ? `${i + 1}.` : '•'} ${inlineText(item)}`)
        .join('\n');
    case 'code':
      return block.code;
    case 'table':
      return [block.header, ...block.rows]
        .map((row) => row.map((cell) => inlineText(cell)).join(' | '))
        .join('\n');
    case 'quote':
    case 'callout':
      return block.blocks.map(blockText).filter(Boolean).join('\n');
    case 'image':
      return block.alt ? `[图] ${block.alt}` : '';
    case 'formula':
      return block.tex;
    case 'hr':
      return '';
  }
}

function inlineText(nodes: InlineNode[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case 'text':
          return node.text;
        case 'strong':
        case 'em':
        case 'link':
          return inlineText(node.children);
        case 'code':
          return node.text;
        case 'image':
          return node.alt;
        case 'formula':
          return node.tex;
        case 'html':
          return node.html.replace(/<[^>]+>/g, '');
        case 'break':
          return '\n';
      }
    })
    .join('');
}
