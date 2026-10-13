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
import type { LayoutIR } from '../ir/types';
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
   * 强制分页边界：IR 块序号集合，命中即「在此块之前另起一页」（画布拖动分页边界的写回通道）。
   *
   * 语义是「至少在这里断」，不是「只能在这里断」：强制收页之后若剩余内容仍放不下，
   * 照常拆分到后续页。**这条约束是为了守住字数守恒**——强制边界永远不裁内容，
   * 用户往上一拖只会让本页变少，往下一拖最多多出几页。
   */
  breaks?: number[];
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
function splitTable(el: HTMLTableElement, fits: () => boolean, doc: Document): HTMLElement | null {
  const tbody = el.tBodies[0];
  if (!tbody) {
    el.remove();
    return null;
  }
  const rows = Array.from(tbody.rows);
  if (rows.length < 2) {
    el.remove();
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
    el.remove();
    return null;
  }
  const tail = el.cloneNode(false) as HTMLTableElement;
  tail.classList.add('mdcore-cont');
  // 跨页重复表头（成对变异钉住：去掉本行使下页丢失表头）
  const thead = el.querySelector('thead');
  if (thead) tail.appendChild(thead.cloneNode(true));
  const tailBody = doc.createElement('tbody');
  tailBody.replaceChildren(...rows.slice(keep).map((r) => r.cloneNode(true)));
  tail.appendChild(tailBody);
  return tail;
}

function makeShell(
  doc: Document,
  theme: Theme,
  overrides: ThemeOverrides,
  spec: PageSpec,
  pad: PagePadding,
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

  const body = doc.createElement('div');
  body.className = 'mdcore-page-body';
  body.style.setProperty('height', '100%');
  body.style.setProperty('overflow', 'hidden');
  applyProps(body, resolveThemedProps(theme, overrides, 'cardBody'));
  page.appendChild(body);
  return { page, body };
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
    const rendered = applyTheme(ir, theme, overrides, doc);
    const blocks = Array.from(rendered.children) as HTMLElement[];

    const pages: HTMLElement[] = [];
    let page!: HTMLElement;
    let body!: HTMLElement;

    const newPage = () => {
      const shell = makeShell(doc, theme, overrides, opts.page, pad);
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
      let el: HTMLElement | null = block;
      body.appendChild(el);
      for (let guard = 0; el && !fits() && guard < 500; guard++) {
        const current: HTMLElement = el;
        const wasAlone = body.children.length === 1;
        const tail: HTMLElement | null = current.matches('table')
          ? splitTable(current as HTMLTableElement, fits, doc)
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
