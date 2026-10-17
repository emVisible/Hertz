/*
 * 测量式分页引擎（§2 paginate/）—— 本模块最核心资产。
 * 机制移植自 mdsea/xiaohongshu-text-layout/js/paginate.js，重写为 TypeScript。
 * 原文件 MIT License，Copyright (c) 2025-present Yutong Wu，
 * 许可全文见 mdsea/xiaohongshu-text-layout/LICENSE。
 *
 *  - 隐藏测量台用与输出完全相同的样式真实排版，Measurer 判定溢出
 *    （默认实现走 getBoundingClientRect；jsdom 不做真实排版，测试注入 mock Measurer）
 *  - 段落 / 列表 / 引用 / 代码放不下时，用 Range.cloneContents 二分查找断点，
 *    拆分保留行内格式
 *  - 表格按行拆，下一页自动重复表头
 *  - 标题不留页尾（孤行控制：标题与它后第一块绑定）
 *  - 断点遵守中文避头尾（闭标点不开行首），不拆英文单词（见 breaks.ts）
 */
import type { IRDiagnostic, LayoutIR } from '../ir/types';
import { applyTheme, resolveThemedProps } from '../theme/apply';
import { themeWithOverrides } from '../theme/derive';
import { resolveTheme } from '../theme/index';
import type { StyleProps, Theme, ThemeOverrides } from '../theme/types';
import { adjustBreak, codeBreak } from './breaks';

/**
 * 测量接口：判定正文区当前内容是否放得下（最后一个子块底边未超出正文区底边）。
 * 浏览器默认实现见 domMeasurer；node/jsdom 测试注入合成块高的 mock。
 */
export interface Measurer {
  fits(body: HTMLElement): boolean;
}

/**
 * 卡片页壳的"装饰件"（小红书卡片向；微信/知乎是连续长文，不传）。
 *
 * 五层结构（参考实现同款）：bg 底纹 / deco 装饰 / header 页眉 / body 正文 / footer 页脚。
 * **只有 body 进测量流**——这是本文件的硬约定：装饰件任意加高都不得影响分页结果，
 * 由paginate.test.ts 的「装饰改高不改变分页」判据守住。
 */
export interface CardChrome {
  /** 页眉小字（每页顶部，弱辅助色） */
  header?: string;
  /** 水印/署名（页脚左侧） */
  watermark?: string;
  /** 页码（页脚右侧）。默认 true——卡片没有页码会让人以为漏页了 */
  pageNum?: boolean;
  /** 底色（缺省取主题的 card 底） */
  bgColor?: string;
  /** 纸纹/网格背景（data URL）。与 bgColor 互斥，bgColor 作兜底色 */
  bgImage?: string;
  /**
   * 纹理不透明度（0~1）。
   *
   * 单独一个旋钮而不是直接给 rgba：纹理的 SVG 里颜色是写死的（才能平铺），
   * "淡一点"只能靠图层透明度——底色是页壳自己的，纹理的 alpha 通道反而会
   * 跟底色叠出脏色。
   */
  textureOpacity?: number;
  /** 背景平铺方式 */
  bgRepeat?: 'repeat' | 'no-repeat';
  /** 背景尺寸（默认 auto；配合 no-repeat 常配 cover） */
  bgSize?: string;
  /**
   * 装饰件：胶带、状态栏、花边……**一律绝对定位**（不进正文流）。
   * `size` 是相对于页宽的百分比，`inset` 是距对应边界的百分比。
   */
  deco?: Array<{
    html: string;
    /** 贴哪条边 */
    anchor: 'top' | 'bottom' | 'left' | 'right';
    /** 水平/垂直方向的对齐端 */
    align?: 'start' | 'center' | 'end';
    /** 贴边偏移（%，默认 0） */
    inset?: number;
    /** 宽度（页宽的 %，默认 100 = 整条边） */
    span?: number;
    /** z 轴（小的被后面的内容盖住） */
    z?: number;
  }>;
}

/** 默认测量：与参考实现一致，比较最后子块与正文区的 getBoundingClientRect 底边 */
export const domMeasurer: Measurer = {
  fits(body) {
    const last = body.lastElementChild;
    if (!last) return true;
    return last.getBoundingClientRect().bottom <= body.getBoundingClientRect().bottom + 0.5;
  },
};

export interface PagePadding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** 页尺寸（px）。padding 四边同值或分别指定（小红书卡片下 padding 含页脚预留位） */
export interface PageSpec {
  width: number;
  height: number;
  padding: number | Partial<PagePadding>;
}

export interface PaginateOptions {
  theme?: Theme | string;
  overrides?: ThemeOverrides;
  page: PageSpec;
  /** 默认 domMeasurer（getBoundingClientRect）；测试注入 mock */
  measurer?: Measurer;
  doc?: Document;
  /**
   * 未建模语法的记账出口（可选）。给了就往里塞，宿主可以拿去给用户看。
   *
   * 过去这条账只有解析层有、渲染层没有，两边不对称——于是"这稿子里有哪些东西
   * 我们没真正支持"没人答得上来。
   */
  diagnostics?: IRDiagnostic[];
  /**
   * 强制分页边界：IR 块序号集合，命中即「在此块之前另起一页」（画布拖动分页边界的写回通道）。
   *
   * 语义是「至少在这里断」，不是「只能在这里断」：强制收页之后若剩余内容仍放不下，
   * 照常拆分到后续页。**这条约束是为了守住字数守恒**——强制边界永远不裁内容，
   * 用户往上一拖只会让本页变少，往下一拖最多多出几页。
   */
  breaks?: number[];
  /** 卡片页壳装饰件（页眉/水印/页码/底纹/贴边装饰）。不给就是纯白页壳 */
  chrome?: CardChrome;
  /**
   * 预渲染的 mermaid 图表（源码键 → SVG，P2-4）。
   *
   * 分页量的是**真实高度**，所以图必须在这之前落地：异步后置会让分页器
   * 按源码文本的高度排版，图一落地卡片就溢出（`platform/xhs.ts` 同规格透传）。
   */
  mermaid?: Map<string, string>;
}

function normalizePadding(p: PageSpec['padding']): PagePadding {
  if (typeof p === 'number') return { top: p, right: p, bottom: p, left: p };
  return { top: p.top ?? 0, right: p.right ?? 0, bottom: p.bottom ?? 0, left: p.left ?? 0 };
}

function applyProps(el: HTMLElement, props: StyleProps): void {
  for (const [prop, value] of Object.entries(props)) {
    el.style.setProperty(prop, value);
  }
}

function isHeading(el: Element | null): boolean {
  return !!el && /^H[1-6]$/.test(el.tagName);
}

/** 代码块的最外层：v0.36 起 `pre` 被包进 `.mdcore-code` 卡片壳（挂圆角与语言标签） */
function isCodeBlock(el: HTMLElement): boolean {
  return el.matches('pre') || !!el.querySelector('pre');
}

/**
 * 可以按字拆分的块，返回承载文字的那个元素。
 *
 * `pre` 藏在代码卡片壳里（v0.36），所以这里必须**下钻一层**——否则 `textBox` 返回
 * null，`splitText` 会走 `el.remove()` 把整块代码丢掉（内容消失而不是分页）。
 */
/**
 * 块元素里的 `<table>`。
 *
 * 表格的块元素现在是 `.mdcore-table-wrap`（窄表横滚容器，W1 切片 2），
 * `matches('table')` 认不出来了——这里统一收口，避免"排版改一次、分页改两处"。
 */
function tableOf(el: HTMLElement): HTMLTableElement | null {
  if (el.matches('table')) return el as HTMLTableElement;
  return el.querySelector('table');
}

function textBox(el: HTMLElement): HTMLElement | null {
  if (el.matches('p, blockquote, ul, ol, li')) return el;
  const pre = el.matches('pre') ? el : el.querySelector('pre');
  if (pre) return pre.querySelector('code') ?? pre;
  return null;
}

interface TextIndex {
  nodes: Array<{ node: Text; start: number }>;
  total: number;
  text: string;
}

/**
 * 收集元素里所有文字节点，以及每个节点在全文中的起始位置。
 *
 * 跳过 `data-mdcore-deco` 子树里的文字：章节序号、列表符号、引用大引号、三圆点是
 * 渲染期物化出来的装饰（伪元素过不了微信清洗器，只能用真节点），它们不是正文——
 * 不跳过的话断点会切进 “ 里，下一页开头挂一个孤零零的引号。
 */
function textIndex(root: HTMLElement, doc: Document): TextIndex {
  const SHOW_TEXT = 4; // NodeFilter.SHOW_TEXT（不依赖全局 NodeFilter）
  const nodes: Array<{ node: Text; start: number }> = [];
  let total = 0;
  const walker = doc.createTreeWalker(root, SHOW_TEXT);
  let current = walker.nextNode();
  while (current) {
    const n = current as Text;
    const deco = (n.parentElement as HTMLElement | null)?.closest('[data-mdcore-deco]');
    if (!deco || deco === root) {
      nodes.push({ node: n, start: total });
      total += n.data.length;
    }
    current = walker.nextNode();
  }
  return { nodes, total, text: nodes.map((n) => n.node.data).join('') };
}

function locate(idx: TextIndex, k: number): { node: Text; offset: number } {
  for (let i = idx.nodes.length - 1; i >= 0; i--) {
    const n = idx.nodes[i];
    if (k >= n.start) return { node: n.node, offset: Math.min(k - n.start, n.node.data.length) };
  }
  return { node: idx.nodes[0].node, offset: 0 };
}

/** 用 Range 截取前 k 个字（或第 k 个字之后）的内容，自动保留外层的格式标签 */
function slice(doc: Document, src: HTMLElement, idx: TextIndex, k: number, head: boolean): DocumentFragment {
  const range = doc.createRange();
  const at = locate(idx, k);
  if (head) {
    range.setStart(src, 0);
    range.setEnd(at.node, at.offset);
  } else {
    range.setStart(at.node, at.offset);
    range.setEnd(src, src.childNodes.length);
  }
  return range.cloneContents();
}

/**
 * 把 el 拆成「这一页放得下的部分」和「剩下的部分」。
 * 调用前 el 已在 body 末尾；返回剩下部分（拆不了返回 null，且 el 被移出 body）。
 */
function splitText(el: HTMLElement, fits: () => boolean, doc: Document): HTMLElement | null {
  const box = textBox(el);
  if (!box) {
    el.remove();
    return null;
  }
  const src = box.cloneNode(true) as HTMLElement;
  const idx = textIndex(src, doc);
  if (idx.total < 2) {
    el.remove();
    return null;
  }

  const put = (k: number) => box.replaceChildren(slice(doc, src, idx, k, true));
  let lo = 1;
  let hi = idx.total - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    put(mid);
    if (fits()) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  let k = best;
  if (k > 0) {
    k = isCodeBlock(el) ? codeBreak(idx.text, k) : adjustBreak(idx.text, k);
  }
  // 这一页只能放下零星几个字时，干脆整块移到下一页
  if (k <= 0 || idx.text.slice(0, k).trim().length < 2) {
    box.replaceChildren(...Array.from((src.cloneNode(true) as HTMLElement).childNodes));
    el.remove();
    return null;
  }

  put(k);
  let rest = k;
  while (rest < idx.total && /\s/.test(idx.text[rest]) && !isCodeBlock(el)) rest++;

  const tail = el.cloneNode(true) as HTMLElement;
  tail.classList.add('mdcore-cont');
  tail.removeAttribute('id');
  // 续页不再重复一遍语言标签/Mac 三色点：它是"这一页从哪开始"的标记，不是内容
  tail.querySelector('.mdcore-code-head')?.remove();
  textBox(tail)?.replaceChildren(slice(doc, src, idx, rest, false));
  el.classList.add('mdcore-split');
  return tail;
}

/** 表格按行拆分，下一页自动重复表头 */
/**
 * 表格按行拆分，下一页自动重复表头。
 *
 * `block` 是页里那个块元素（现在是横滚容器），`table` 是它里面的 table。
 * 拆出来的续块要**克隆容器**而不是克隆 table——否则续页少了 `overflow-x:auto`，
 * 宽表在续页又变成"逐字折行"。
 */
function splitTable(
  block: HTMLElement,
  table: HTMLTableElement,
  fits: () => boolean,
  doc: Document,
  theme: Theme,
  overrides: ThemeOverrides,
): HTMLElement | null {
  const el = table;
  const tbody = el.tBodies[0];
  if (!tbody) {
    block.remove();
    return null;
  }
  const rows = Array.from(tbody.rows);
  if (rows.length < 2) {
    block.remove();
    return null;
  }
  // keep = 留在这一页的行数，从后往前一行行挪走，直到放得下
  let keep = rows.length;
  while (keep > 1) {
    rows[--keep].remove();
    if (fits()) break;
  }
  if (!fits()) {
    tbody.replaceChildren(...rows);
    block.remove();
    return null;
  }
  // 续块克隆**容器**（不是 table）：容器上带着 overflow-x:auto 与样式槽，
  // 只克隆 table 的话续页的宽表又变成逐字折行
  const tailWrap = block.cloneNode(false) as HTMLElement;
  tailWrap.classList.add('mdcore-cont');
  const tail = doc.createElement('table');
  applyProps(tail, resolveThemedProps(theme, overrides, 'table'));
  // 跨页重复表头（成对变异钉住：去掉本行使下页丢失表头）
  const thead = el.querySelector('thead');
  if (thead) tail.appendChild(thead.cloneNode(true));
  const tailBody = doc.createElement('tbody');
  tailBody.replaceChildren(...rows.slice(keep).map((r) => r.cloneNode(true)));
  tail.appendChild(tailBody);
  tailWrap.appendChild(tail);
  return tailWrap;
}

function makeShell(
  doc: Document,
  theme: Theme,
  overrides: ThemeOverrides,
  spec: PageSpec,
  pad: PagePadding,
  chrome?: CardChrome,
): { page: HTMLElement; body: HTMLElement } {
  const page = doc.createElement('section');
  page.className = 'mdcore-page';
  page.style.setProperty('box-sizing', 'border-box');
  page.style.setProperty('position', 'relative');
  page.style.setProperty('overflow', 'hidden');
  page.style.setProperty('width', `${spec.width}px`);
  page.style.setProperty('height', `${spec.height}px`);
  page.style.setProperty(
    'padding',
    `${pad.top}px ${pad.right}px ${pad.bottom}px ${pad.left}px`,
  );
  // 主题卡片样式（xhs 主题提供 card 键：底色/圆角等）
  applyProps(page, resolveThemedProps(theme, overrides, 'card'));
  // 基线字体会落到页壳上：applyTheme 是挂在 container 上的，而分页页壳没有
  // container 这一层——漏掉它，卡片正文会退回浏览器默认 16px（1242px 画幅里
  // 小成一粒米，且底部空一大片）。overrides 里的字号/行距同样要生效。
  const base = { ...themeWithOverrides(theme, overrides).tokens, ...overrides };
  page.style.setProperty('font-family', base.fontFamily);
  page.style.setProperty('font-size', base.fontSize);
  page.style.setProperty('line-height', base.lineHeight);

  /**
   * 五层页壳：bg 底纹 / deco 装饰 / header 页眉 / body 正文 / footer 页脚。
   *
   * 原来只有 body 一层，所以卡片既没有底纹也没有装饰位——"小红书感"无从谈起。
   * 关键约定：**除 body 外的层全部绝对定位**，不进正文流，也就不进测量；
   * 装饰加高 999px 也不该影响分页（paginate.test.ts 有这条判据）。
   *
   * body 因此改成撑满内容区（`flex:1` + `position:relative`），让页眉页脚
   * 自然落在 padding 之内而不是绝对定位到页角——后者会和正文重叠。
   */
  page.style.setProperty('display', 'flex');
  page.style.setProperty('flex-direction', 'column');

  // ── bg 底纹
  if (chrome?.bgImage || chrome?.bgColor) {
    const bg = doc.createElement('div');
    bg.className = 'mdcore-card-bg';
    bg.setAttribute('aria-hidden', 'true');
    bg.style.setProperty('position', 'absolute');
    bg.style.setProperty('inset', '0');
    bg.style.setProperty('z-index', '0');
    if (chrome.bgColor) bg.style.setProperty('background-color', chrome.bgColor);
    if (chrome.bgImage) {
      // url() 里加引号：data URL 里带分号与括号（`;charset=utf-8,`、`%3C`），
      // 不加引号时 jsdom 直接把这张背景判为非法并丢弃——浏览器能过，测试里却"没有纹理"，
      // 判据就成了摆设。加引号两边都稳。
      bg.style.setProperty('background-image', `url("${chrome.bgImage}")`);
      // 正片叠底：纹理"印"在底色上，而不是盖住底色
      bg.style.setProperty('background-blend-mode', 'multiply');
      bg.style.setProperty('opacity', String(chrome.textureOpacity ?? 1));
      bg.style.setProperty('background-repeat', chrome.bgRepeat ?? 'repeat');
      bg.style.setProperty('background-size', chrome.bgSize ?? 'auto');
      if (!chrome.bgColor) bg.style.setProperty('background-color', '#ffffff');
    }
    page.appendChild(bg);
  }

  // ── deco 装饰（贴边，绝对定位）
  for (const item of chrome?.deco ?? []) {
    const layer = doc.createElement('div');
    layer.className = 'mdcore-card-deco';
    layer.setAttribute('aria-hidden', 'true');
    layer.innerHTML = item.html;
    layer.style.setProperty('position', 'absolute');
    layer.style.setProperty('z-index', String(item.z ?? 1));
    const inset = `${item.inset ?? 0}%`;
    const span = `${item.span ?? 100}%`;
    switch (item.anchor) {
      case 'top':
        layer.style.setProperty('top', inset);
        layer.style.setProperty('height', 'auto');
        break;
      case 'bottom':
        layer.style.setProperty('bottom', inset);
        layer.style.setProperty('height', 'auto');
        break;
      case 'left':
        layer.style.setProperty('left', inset);
        layer.style.setProperty('width', 'auto');
        break;
      case 'right':
        layer.style.setProperty('right', inset);
        layer.style.setProperty('width', 'auto');
        break;
    }
    // 贴 top/bottom 的横向落位、贴 left/right 的纵向落位
    const cross: Record<string, string> = { start: 'flex-start', center: 'center', end: 'flex-end' };
    const align = cross[item.align ?? 'center'] ?? 'center';
    if (item.anchor === 'top' || item.anchor === 'bottom') {
      layer.style.setProperty('left', '50%');
      layer.style.setProperty('width', span);
      layer.style.setProperty('transform', `translateX(${alignOffset(align)})`);
    } else {
      layer.style.setProperty('top', '50%');
      layer.style.setProperty('height', span);
      layer.style.setProperty('transform', `translateY(${alignOffset(align)})`);
    }
    page.appendChild(layer);
  }

  // ── header 页眉
  if (chrome?.header?.trim()) {
    const header = doc.createElement('div');
    header.className = 'mdcore-card-header';
    header.textContent = chrome.header.trim();
    applyProps(header, resolveThemedProps(theme, overrides, 'cardHeader'));
    // 页眉页脚与正文同级：定位元素（bg/deco）默认画在普通流之上，
    // 不显式给 z-index 的话，页脚会被 85% 不透明的纹理层盖住——
    // 症状是"页脚文字淡得快看不见"，而结构层与 jsdom 断言都看不出来。
    header.style.setProperty('position', 'relative');
    header.style.setProperty('z-index', '1');
    page.appendChild(header);
  }

  // ── body 正文（唯一进测量流的层）
  const body = doc.createElement('div');
  body.className = 'mdcore-page-body';
  body.style.setProperty('position', 'relative');
  body.style.setProperty('z-index', '1');
  body.style.setProperty('flex', '1 1 auto');
  body.style.setProperty('min-height', '0');
  body.style.setProperty('overflow', 'hidden');
  applyProps(body, resolveThemedProps(theme, overrides, 'cardBody'));
  page.appendChild(body);

  // ── footer 页脚（水印 + 页码）
  if (chrome && (chrome.watermark?.trim() || chrome.pageNum !== false)) {
    const footer = doc.createElement('div');
    footer.className = 'mdcore-card-footer';
    footer.style.setProperty('position', 'relative');
    footer.style.setProperty('z-index', '1');
    /**
     * 页脚是 flex 行，页码靠 `margin-left: auto` 顶到右端。
     *
     * 早先它是普通块，里面 `[署名][页码]` 按文档流排：页码紧跟署名，于是它落在
     * **左下角**，而且署名一长（或带了二维码）就换行、页码跟着往下掉。
     * 「页码固定在右下角」这条要求此前一点没被满足——而结构层看着"有个页码节点"，
     * 没有任何断言会红。
     *
     * 用 flex 行而不是绝对定位：绝对定位的页码在二维码、页码、页眉同时开时容易压到
     * 彼此；flex 行里"右端"是布局算出来的，改内容也不会跑位。
     */
    footer.style.setProperty('display', 'flex');
    footer.style.setProperty('align-items', 'baseline');
    footer.style.setProperty('justify-content', 'space-between');
    footer.style.setProperty('gap', '12px');
    applyProps(footer, resolveThemedProps(theme, overrides, 'cardFooter'));
    if (chrome.watermark?.trim()) {
      const wm = doc.createElement('span');
      wm.className = 'mdcore-card-watermark';
      wm.textContent = chrome.watermark.trim();
      // 署名吃掉剩余空间：太长就自己省略，而不是把页码挤下去
      wm.style.setProperty('flex', '1 1 auto');
      wm.style.setProperty('min-width', '0');
      wm.style.setProperty('overflow', 'hidden');
      wm.style.setProperty('text-overflow', 'ellipsis');
      wm.style.setProperty('white-space', 'nowrap');
      footer.appendChild(wm);
    }
    if (chrome.pageNum !== false) {
      const num = doc.createElement('span');
      num.className = 'mdcore-card-pageno';
      num.dataset.pageSlot = '1';
      // 顶到右端且不被压缩：`auto` 左边距 + `none` 弹性 + 不换行，三条一起才叫"固定"
      num.style.setProperty('margin-left', 'auto');
      // 用长写而不是 `flex: none` 简写：简写读回来是 '0 0 auto'，判据只能盯着
      // 一串魔数。长写读回来就是 '0'/'1'，判据读得懂，产品行为也一样。
      num.style.setProperty('flex-grow', '0');
      num.style.setProperty('flex-shrink', '0');
      num.style.setProperty('white-space', 'nowrap');
      footer.appendChild(num);
    }
    page.appendChild(footer);
  }

  return { page, body };
}

/** flex 对齐 → translate 百分比偏移（装饰层用绝对定位代替 flex） */
function alignOffset(align: string): string {
  if (align === 'center') return '-50%';
  return align === 'flex-end' ? '-100%' : '0';
}

/**
 * 建一张**空白卡片页壳**（封面页等"没有正文"的卡片要用）。
 *
 * 为什么单独导出：小红书封面是独立的一页（`is-cover`），它不进分页流程，
 * 但要跟正文页**长得一模一样**——同一套壳、同一套装饰、同一套边距。
 * 另写一套封面样式，迟早会和正文页漂。
 */
export function createCardShell(opts: {
  doc?: Document;
  theme: Theme | string;
  overrides?: ThemeOverrides;
  page: PageSpec;
  chrome?: CardChrome;
  /** 封面页：正文区换成一块垂直居中的内容区（标题/副标题/角标） */
  cover?: boolean;
}): { page: HTMLElement; body: HTMLElement } {
  const doc = opts.doc ?? globalThis.document;
  if (!doc) throw new Error('@hertz/mdcore: createCardShell 需要 DOM 环境');
  const theme = resolveTheme(opts.theme ?? 'modi');
  const pad = normalizePadding(opts.page.padding);
  const shell = makeShell(doc, theme, opts.overrides ?? {}, opts.page, pad, opts.chrome);
  if (!opts.cover) return shell;
  shell.page.dataset.cover = 'true';
  shell.body.classList.add('mdcore-cover-body');
  shell.body.style.setProperty('display', 'flex');
  shell.body.style.setProperty('flex-direction', 'column');
  shell.body.style.setProperty('justify-content', 'center');
  return shell;
}

/**
 * 分页主流程：LayoutIR + Theme + overrides + 页尺寸 → 每页一个挂好样式的卡片容器。
 * 预览/导出同一份渲染态（§1 铁律 3）：返回的 HTMLElement[] 即画布 DOM，也是截图源。
 */
export function paginate(ir: LayoutIR, opts: PaginateOptions): HTMLElement[] {
  const doc = opts.doc ?? globalThis.document;
  if (!doc) throw new Error('@hertz/mdcore: paginate 需要 DOM 环境（浏览器或 jsdom）');
  const theme = resolveTheme(opts.theme ?? 'modi');
  const overrides = opts.overrides ?? {};
  const measurer = opts.measurer ?? domMeasurer;
  const pad = normalizePadding(opts.page.padding);

  // 隐藏测量台：与输出完全相同的页壳，真实排版判溢出
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
    const rendered = applyTheme(ir, theme, overrides, doc, opts.diagnostics, {
      mermaid: opts.mermaid,
    });
    const blocks = Array.from(rendered.children) as HTMLElement[];

    const pages: HTMLElement[] = [];
    let page!: HTMLElement;
    let body!: HTMLElement;

    const newPage = () => {
      const shell = makeShell(doc, theme, overrides, opts.page, pad, opts.chrome);
      page = shell.page;
      body = shell.body;
      stage.replaceChildren(page);
    };
    const fits = () => measurer.fits(body);

    const closePage = () => {
      // 孤行控制：标题不要孤零零留在页尾，和它后面的内容一起挪到下一页
      const carry: HTMLElement[] = [];
      while (body.children.length > 1 && isHeading(body.lastElementChild)) {
        carry.unshift(body.lastElementChild as HTMLElement);
        body.lastElementChild!.remove();
      }
      if (body.children.length) pages.push(page);
      newPage();
      for (const c of carry) body.appendChild(c);
    };

    newPage();
    // 强制边界（画布拖动分页边界写回的通道）：页内已有内容才收页，否则会凭空多一张空页
    const forced = new Set(
      (opts.breaks ?? []).filter((n) => Number.isInteger(n) && n > 0),
    );
    for (const [index, block] of blocks.entries()) {
      if (forced.has(index) && body.children.length) closePage();
      // `---` 强制分页：作者自己划了段落边界。页内已有内容才收页，
      // 否则开头就一个 `---` 会凭空多出一张空卡。
      if (block.classList.contains('mdcore-pagebreak')) {
        block.remove();
        if (body.children.length) closePage();
        continue;
      }
      let el: HTMLElement | null = block;
      body.appendChild(el);
      for (let guard = 0; el && !fits() && guard < 500; guard++) {
        const current: HTMLElement = el;
        const wasAlone = body.children.length === 1;
        const table = tableOf(current);
        const tail: HTMLElement | null = table
          ? splitTable(current, table, fits, doc, theme, overrides)
          : splitText(current, fits, doc);
        if (tail) {
          closePage();
          el = tail;
          body.appendChild(el);
        } else if (wasAlone) {
          // 一整页都放不下（比如超大图），只能硬放，超出部分被页壳裁掉
          body.appendChild(current);
          break;
        } else {
          closePage();
          body.appendChild(current);
        }
      }
    }
    if (body.children.length) pages.push(page);
    if (pages.length === 0) pages.push(page);
    return pages;
  } finally {
    stage.remove();
  }
}
