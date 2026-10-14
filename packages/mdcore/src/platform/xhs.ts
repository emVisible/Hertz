/**
 * 小红书适配器（§3.3）：3:4（1242×1656）测量分页卡片。
 *  - 自动封面：第一页首块是 heading 则放大居中做成封面页
 *  - 品牌页脚：每页底部页码 + 可配置署名（footer）
 *  - 18 页上限：超出返回 overflow:true 与建议，不静默截断
 *  - 文案导出 xhsCaption：纯文本（标题+正文+尾部话题标签位），供复制。不做直发。
 */
import type { InlineNode, IRBlock, LayoutIR } from '../ir/types';
import { createCardShell, paginate } from '../paginate/paginate';
import type { CardChrome, Measurer, PagePadding } from '../paginate/paginate';
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
  /** 缺省 true：首块是 heading 时生成一张**独立封面页**（v0.36 起不再与正文同页） */
  cover?: boolean;
  /** 封面标题（留空则取正文第一个 H1；支持行内 ==高亮== / **加粗**） */
  coverTitle?: string;
  /** 封面副标题：一句话说明看完能得到什么 */
  coverSubtitle?: string;
  /** 封面角标：干货 / 保姆级 / 建议收藏 */
  coverBadge?: string;
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

  /** 页眉小字（每页顶部，可选） */
  header?: string;
  /** 页码开关（缺省 true） */
  pageNum?: boolean;
  /** 卡片底色（缺省取主题 card 底） */
  cardBgColor?: string;
  /** 纸纹/网格背景（data URL） */
  cardBgImage?: string;
  cardBgRepeat?: 'repeat' | 'no-repeat';
  cardBgSize?: string;
  /** 贴边装饰件（主题装饰层，见 CardChrome） */
  cardDeco?: CardChrome['deco'];
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
    // 页壳装饰件：页脚的水印与页码由 paginate 建层，这里只传意图（内容随后填进槽里）
    chrome: {
      watermark: opts.footer,
      pageNum: opts.pageNum ?? true,
      bgColor: opts.cardBgColor,
      bgImage: opts.cardBgImage,
      bgRepeat: opts.cardBgRepeat,
      bgSize: opts.cardBgSize,
      deco: opts.cardDeco,
    },
  });

  /**
   * 封面是**独立的一页**，插在最前面。
   *
   * 之前封面是"第一页同时装标题和正文"，而且是在分页**之后**把标题放大 1.5 倍——
   * 放大之后这一页未必还装得下，页壳 overflow:hidden 会把超出的部分直接裁掉。
   * 这就是「长文分页不对（溢出/截断）」里最隐蔽的一条：结构层与基线图都看不出来，
   * 因为短样例放大后仍有大量留白。
   *
   * 现在：①封面独立成页，正文页整体后移；②标题块从正文流里摘掉（不再重复出现）；
   * ③封面标题字号在测量台上二分自适应，**保证放得下**。
   */
  const contentPages = pages;
  const cover = opts.cover === false ? null : buildCover(doc, theme, overrides, contentPages[0], opts);
  if (cover && contentPages.length) {
    // 标题摘不摘，看封面标题的**来源**：
    // - 取自正文第一个 H1 → 摘掉（否则同一句话在封面和正文各出现一次）
    // - 用户自定义了封面标题 → 正文 H1 留在正文流里（那是作者写的内容，删了是丢内容）
    if (cover.takenFromDoc) {
      const first = contentPages[0].querySelector('.mdcore-page-body') as HTMLElement | null;
      const heading = first?.firstElementChild as HTMLElement | null;
      if (!heading || !/^H[1-6]$/.test(heading.tagName)) return finish(contentPages, opts, null);
      heading.remove();
    }
    contentPages.unshift(cover.page);
  }
  return finish(contentPages, opts, cover?.page ?? null);

  function finish(all: HTMLElement[], o: XhsOptions, coverPage: HTMLElement | null): XhsResult {
    all.forEach((page, i) => {
      // 封面页不排页码（第几页在角标里已经写了）
      if (page === coverPage) return;
      fillFooter(doc, theme, overrides, page, i - (coverPage ? 1 : 0), all.length, o.qr);
    });
    const max = o.maxPages ?? XHS_MAX_PAGES;
    const overflow = all.length > max;
    return {
      pages: all,
      pageCount: all.length,
      overflow,
      suggestion: overflow
        ? `内容共 ${all.length} 页，超出小红书 ${max} 页上限：建议精简内容，或拆分为 ${Math.ceil(all.length / max)} 篇笔记。`
        : undefined,
    };
  }
}

/** 封面页：独立页壳 + 角标/标题/副标题/页数提示，字号在测量台上二分自适应 */
function buildCover(
  doc: Document,
  theme: Theme,
  overrides: ThemeOverrides,
  firstContent: HTMLElement | undefined,
  opts: XhsOptions,
): { page: HTMLElement; takenFromDoc: boolean } | null {
  const fromDoc = (firstContent?.querySelector('.mdcore-page-body > h1, .mdcore-page-body > h2')?.textContent ?? '').trim();
  const custom = opts.coverTitle?.trim();
  const sourceTitle = custom || fromDoc;
  if (!sourceTitle) return null;

  const chrome: CardChrome = {
    watermark: opts.footer,
    pageNum: false,
    bgColor: opts.cardBgColor,
    bgImage: opts.cardBgImage,
    bgRepeat: opts.cardBgRepeat,
    bgSize: opts.cardBgSize,
    deco: opts.cardDeco,
  };
  const { page, body } = createCardShell({
    doc,
    theme,
    overrides,
    page: coverPageSpec(opts),
    chrome,
    cover: true,
  });

  const wrap = doc.createElement('div');
  wrap.className = 'mdcore-cover';
  wrap.style.setProperty('display', 'flex');
  wrap.style.setProperty('flex-direction', 'column');
  wrap.style.setProperty('gap', '0.5em');

  if (opts.coverBadge?.trim()) {
    const badge = doc.createElement('span');
    badge.className = 'mdcore-cover-badge';
    badge.textContent = opts.coverBadge.trim();
    applyCoverProps(badge, theme, overrides, 'coverBadge');
    wrap.appendChild(badge);
  }
  const title = doc.createElement('h1');
  title.className = 'mdcore-cover-title';
  title.textContent = sourceTitle;
  applyCoverProps(title, theme, overrides, 'coverTitle');
  wrap.appendChild(title);
  if (opts.coverSubtitle?.trim()) {
    const sub = doc.createElement('p');
    sub.className = 'mdcore-cover-sub';
    sub.textContent = opts.coverSubtitle.trim();
    applyCoverProps(sub, theme, overrides, 'coverSub');
    wrap.appendChild(sub);
  }
  body.appendChild(wrap);

  fitCoverTitle(doc, page);
  return { page, takenFromDoc: !custom };
}

/** 封面页尺寸（含封面页脚的留白） */
function coverPageSpec(opts: XhsOptions): { width: number; height: number; padding: PagePadding } {
  return {
    width: XHS_CARD.width,
    height: XHS_CARD.height,
    padding: {
      top: XHS_CARD.padding,
      right: XHS_CARD.padding,
      bottom: XHS_CARD.padding + (opts.qr ? QR_FOOTER_SPACE : XHS_CARD.footerSpace),
      left: XHS_CARD.padding,
    },
  };
}

/** 封面件样式：走主题的样式槽（角标药丸、标题字色、副标题弱一档） */
function applyCoverProps(
  el: HTMLElement,
  theme: Theme,
  overrides: ThemeOverrides,
  slot: 'coverBadge' | 'coverTitle' | 'coverSub',
): void {
  for (const [prop, value] of Object.entries(resolveThemedProps(theme, overrides, slot))) {
    el.style.setProperty(prop, value);
  }
}

/**
 * 封面标题字号自适应：二分找"尽量大但仍放得下"的字号。
 *
 * 三个要点，都是踩出来的：
 * ①**必须量整页克隆件**，不能只把封面内容块丢进测量台——测量台没有卡片宽度，
 *   标题在无宽度约束下换行更少、显得更矮，二分就会选一个过大的字号，角标与副标题
 *   在真卡片里被 overflow:hidden 裁掉（第一版就是这么做的，基线图一眼看出来）。
 * ②**判据是正文区有没有溢出**，不是"标题多高"——角标、副标题都是封面内容的一部分。
 * ③量的是**克隆件**：`replaceChildren` 是搬运不是复制，量完 remove() 会把封面
 *   一起带走（症状：封面页 textContent 为空）。
 */
function fitCoverTitle(doc: Document, page: HTMLElement): void {
  const probe = page.cloneNode(true) as HTMLElement;
  const probeBody = probe.querySelector('.mdcore-page-body') as HTMLElement | null;
  const probeTitle = probe.querySelector('.mdcore-cover-title') as HTMLElement | null;
  if (!probeBody || !probeTitle) return;

  const stage = doc.createElement('div');
  stage.className = 'mdcore-measure-stage';
  stage.setAttribute('aria-hidden', 'true');
  stage.style.setProperty('position', 'absolute');
  stage.style.setProperty('left', '-100000px');
  stage.style.setProperty('top', '0');
  stage.style.setProperty('visibility', 'hidden');
  stage.style.setProperty('pointer-events', 'none');
  doc.body.appendChild(stage);
  try {
    stage.replaceChildren(probe);
    const fits = (): boolean => probeBody.scrollHeight <= probeBody.clientHeight + 0.5;
    let lo = 40;
    let hi = 260;
    let best = lo;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      probeTitle.style.setProperty('font-size', `${mid}px`);
      if (fits()) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    const title = page.querySelector('.mdcore-cover-title') as HTMLElement | null;
    title?.style.setProperty('font-size', `${best}px`);
  } finally {
    stage.remove();
  }
}

/** 品牌页脚：填页脚层里的水印/页码槽 + 右侧二维码。页脚层本身由 paginate 建好（不进测量流） */
function fillFooter(
  doc: Document,
  theme: Theme,
  overrides: ThemeOverrides,
  page: HTMLElement,
  index: number,
  total: number,
  qr?: string | null,
): void {
  const footer = page.querySelector('.mdcore-card-footer') as HTMLElement | null;
  if (!footer) return;
  // 页码槽由页壳预建（页码可关，所以可能不存在）
  const num = footer.querySelector('.mdcore-card-pageno') as HTMLElement | null;
  if (num) num.textContent = `${index + 1} / ${total}`;
  // 署名：页脚层建的时候可能没有（footer 为空），这里补一个
  if (!footer.querySelector('.mdcore-card-watermark')) {
    const brand = doc.createElement('span');
    brand.className = 'mdcore-card-watermark';
    for (const [prop, value] of Object.entries(resolveThemedProps(theme, overrides, 'cardFooter'))) {
      brand.style.setProperty(prop, value);
    }
    footer.insertBefore(brand, footer.firstChild);
  }
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
    footer.appendChild(img);
  }
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
    case 'toc':
      // 目录条目也进文案：小红书发布时带上目录，读者一眼看到结构
      return block.items.map((i) => `${'　'.repeat(i.level - 2)}${i.text}`).join('\n');
    case 'deflist':
      return block.items
        .map((item) => [inlineText(item.term), ...item.defs.map((d) => `　${inlineText(d)}`)].join('\n'))
        .join('\n');
    case 'footnotes':
      return block.items
        .map((item) => `[${item.label || item.id + 1}] ${item.blocks.map(blockText).join(' ')}`)
        .join('\n');
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
