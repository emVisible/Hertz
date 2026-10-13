/**
 * 知乎适配器（§3.2 降级渲染器）。
 *
 * 输入：渲染态画布 DOM（applyTheme 产物）或其 ownerDocument（与微信同形）。
 * 输出：{ html, text } 剪贴板 payload；复制走 inline.ts 的 ClipboardItem 双写。
 *
 * 降级规则（知乎编辑器不收/会毁形的结构）：
 *  - 表格 → 占位图容器：浏览器端 capture 表格节点转 dataURL img；
 *    jsdom/捕获失败退化为带边框 div + 逐行文本（单元格以 | 分隔）。
 *  - 公式（katex / mjx-container）→ 文本化 LaTeX 源码：
 *    块级 $$...$$，行内 $...$（知乎支持 MathJax 语法，发布端会再排版）。
 *  - 有序列表 → 保留 `1. ` 文本编号的 p 序列；无序 → `• ` 前缀；嵌套列表拍平为同级 p。
 *  - 其余复用微信同规格 inline 快照（platform/inline.ts）；http(s) 链接保留
 *    <a href>（知乎支持链接卡片，不转脚注）。
 */
import { panguSpacingDOM } from './pangu';
import {
  hardenCodeBlocks,
  inlineComputedStyles,
  normalizeText,
  replaceTag,
  snapshotClone,
  stripUnsafe,
} from './inline';

export interface ZhihuPayload {
  html: string;
  text: string;
}

/** 表格捕获：table 节点 → PNG dataURL（浏览器默认 snapdom；测试注入 mock） */
export type TableCapture = (table: HTMLTableElement) => Promise<string>;

export interface ZhihuOptions {
  /** 缺省 snapdom 截图；传 null 强制文本退化（无图环境） */
  captureTable?: TableCapture | null;
}

/** 占位图容器样式：带边框，图文流里可辨识 */
const TABLE_HOLDER_STYLE = 'border:1px solid #dfe3e8;border-radius:6px;padding:12px 16px;margin:0 0 16px;';

/** 知乎安全标签：保留原样（blockquote/a 原生支持；div 留给表格占位容器） */
const KEEP_TAGS = new Set([
  'SECTION',
  'DIV',
  'P',
  'SPAN',
  'STRONG',
  'EM',
  'IMG',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'PRE',
  'CODE',
  'BLOCKQUOTE',
  'HR',
  'BR',
  'SUP',
  'SUB',
]);

/** 直接剥除的标签（连同内容） */
const DROP_TAGS = new Set([
  'STYLE',
  'SCRIPT',
  'LINK',
  'META',
  'TITLE',
  'NOSCRIPT',
  'TEMPLATE',
  'IFRAME',
  'OBJECT',
  'EMBED',
  'SVG',
  'CANVAS',
  'VIDEO',
  'AUDIO',
  'SOURCE',
  'BUTTON',
  'INPUT',
  'SELECT',
  'TEXTAREA',
  'FORM',
]);

/** 结构扁平化映射（表格/公式/列表已在前面步骤处理，不落这里） */
const TAG_MAP: Record<string, string> = {
  B: 'strong',
  I: 'em',
  U: 'span',
  S: 'span',
  DEL: 'span',
  INS: 'span',
  MARK: 'span',
  SMALL: 'span',
  BIG: 'span',
  ABBR: 'span',
  STRIKE: 'span',
  FONT: 'span',
  CENTER: 'span',
  ARTICLE: 'section',
  ASIDE: 'section',
  HEADER: 'section',
  FOOTER: 'section',
  NAV: 'section',
  MAIN: 'section',
  FIGURE: 'section',
  FIGCAPTION: 'p',
  DL: 'section',
  DT: 'p',
  DD: 'p',
  DETAILS: 'section',
  SUMMARY: 'p',
  TABLE: 'section',
  THEAD: 'section',
  TBODY: 'section',
  TR: 'p',
  TD: 'span',
  TH: 'span',
};

/**
 * 渲染态 DOM → 知乎剪贴板 payload。
 * 不改动入参 DOM：全程在深克隆上操作。表格快照是异步的，故整体 async。
 */
export async function toZhihuClipboardPayload(
  input: Document | HTMLElement,
  opts: ZhihuOptions = {},
): Promise<ZhihuPayload> {
  const { clone, win, cleanup } = snapshotClone(input, 'zhihuPayload');
  try {
    inlineComputedStyles(clone, win);
    await degradeTables(clone, opts.captureTable);
    formulasToTexSource(clone);
    flattenLists(clone);
    hardenCodeBlocks(clone);
    flattenStructureZhihu(clone);
    stripUnsafe(clone);
    // pangu 放最后：公式源码文本在 formulasToTexSource 已落盘，
    // pangu 只处理 CJK↔拉丁边界，纯 TeX 源码不受影响
    panguSpacingDOM(clone);

    return { html: clone.innerHTML, text: normalizeText(clone) };
  } finally {
    cleanup();
  }
}

/** 默认表格捕获：snapdom.toBlob → FileReader 转 dataURL */
async function defaultTableCapture(table: HTMLTableElement): Promise<string> {
  const { snapdom } = await import('@zumer/snapdom');
  const blob = await snapdom.toBlob(table, { type: 'png' });
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(blob);
  });
}

/** 表格 → 逐行文本（退化路径）：表头在前，行内单元格以 | 分隔 */
function tableLines(table: HTMLTableElement): string[] {
  const lines: string[] = [];
  for (const tr of Array.from(table.querySelectorAll('tr'))) {
    const cells = Array.from(tr.querySelectorAll('th, td')).map((c) => (c.textContent ?? '').trim());
    if (cells.length) lines.push(cells.join(' | '));
  }
  return lines;
}

/**
 * 表格降级 → 占位图容器（div）：
 *  - 浏览器端：capture 表格节点转 dataURL img 内嵌（知乎收 <img>）；
 *  - jsdom/捕获失败：带边框 div + 逐行文本。
 */
async function degradeTables(root: HTMLElement, capture?: TableCapture | null): Promise<void> {
  const doc = root.ownerDocument;
  for (const table of Array.from(root.querySelectorAll('table'))) {
    const holder = doc.createElement('div');
    holder.setAttribute('style', TABLE_HOLDER_STYLE);

    let dataUrl: string | null = null;
    if (capture !== null) {
      try {
        dataUrl = await (capture ?? defaultTableCapture)(table);
      } catch {
        dataUrl = null; // jsdom 无 canvas / 截图失败 → 文本退化
      }
    }

    if (dataUrl) {
      const img = doc.createElement('img');
      img.setAttribute('src', dataUrl);
      img.setAttribute('alt', '表格');
      img.style.setProperty('max-width', '100%');
      holder.appendChild(img);
    } else {
      const lines = tableLines(table);
      lines.forEach((line, i) => {
        if (i > 0) holder.appendChild(doc.createElement('br'));
        holder.appendChild(doc.createTextNode(line));
      });
    }
    table.replaceWith(holder);
  }
}

/** 从 katex / mjx 产物里提取 LaTeX 源码 */
function texSourceOf(el: Element): string | null {
  const ann = el.querySelector('annotation[encoding="application/x-tex"]');
  if (ann?.textContent?.trim()) return ann.textContent;
  const alt = el.getAttribute('alttext'); // MathJax mjx-container 保留 alttext
  return alt?.trim() ? alt : null;
}

/**
 * 公式 → 文本化 LaTeX 源码（知乎支持 MathJax 语法，发布端再排版）：
 * 块级（katex-display / mjx[display]）→ p 内 `$$源码$$`；行内 → `$源码$` 文本节点。
 */
function formulasToTexSource(root: HTMLElement): void {
  const doc = root.ownerDocument;
  for (const el of Array.from(root.querySelectorAll('.katex-display, mjx-container[display="true"]'))) {
    const tex = texSourceOf(el);
    if (!tex) continue;
    const p = doc.createElement('p');
    p.style.setProperty('text-align', 'center');
    p.textContent = `$$${tex}$$`;
    el.replaceWith(p);
  }
  for (const el of Array.from(root.querySelectorAll('.katex, mjx-container'))) {
    const tex = texSourceOf(el);
    if (!tex) continue;
    el.replaceWith(doc.createTextNode(`$${tex}$`));
  }
}

/**
 * 列表拍平（知乎编辑器粘贴富文本时 ol/ul 层级易毁）：
 * 有序 → `1. ` 文本编号 p 序列；无序 → `• ` 前缀；嵌套列表递归展开为同级 p，序保持。
 */
function flattenLists(root: HTMLElement): void {
  const doc = root.ownerDocument;
  const topLists = Array.from(root.querySelectorAll('ol, ul')).filter(
    (list) => !list.parentElement?.closest('ol, ul'),
  );
  for (const list of topLists) {
    const frag = doc.createDocumentFragment();
    for (const p of expandList(list)) frag.appendChild(p);
    list.replaceWith(frag);
  }

  function expandList(list: Element): HTMLElement[] {
    const ordered = list.tagName === 'OL';
    const out: HTMLElement[] = [];
    let idx = 0;
    for (const li of Array.from(list.children)) {
      if (li.tagName !== 'LI') continue;
      idx += 1;
      const p = doc.createElement('p');
      for (const attr of Array.from(li.attributes)) p.setAttribute(attr.name, attr.value);
      // 渲染层已自绘序号时不再补文本前缀（否则序号出现两次），见 wechat.ts 同处说明
      if (!li.querySelector('.mdcore-marker')) {
        p.appendChild(doc.createTextNode(ordered ? `${idx}. ` : '• '));
      }
      const nested: Element[] = [];
      for (const node of Array.from(li.childNodes)) {
        if (node.nodeType === 1 && /^(UL|OL)$/.test((node as Element).tagName)) {
          nested.push(node as Element);
        } else {
          p.appendChild(node);
        }
      }
      out.push(p);
      for (const n of nested) out.push(...expandList(n));
    }
    return out;
  }
}

/** 结构扁平化 —— 块级一律 section/p，行内降级 span/strong/em；http(s) <a> 保留 */
function flattenStructureZhihu(root: HTMLElement): void {
  const transform = (el: Element): void => {
    for (const child of Array.from(el.children)) transform(child);
    if (el === root) return;

    const tag = el.tagName;
    if (KEEP_TAGS.has(tag)) return;
    if (DROP_TAGS.has(tag)) {
      el.remove();
      return;
    }
    if (tag === 'A') {
      // 知乎支持链接卡片：保留 http(s) 链接；锚点/相对链接剥 href 降为 span
      const href = el.getAttribute('href') ?? '';
      if (!/^https?:\/\//i.test(href)) replaceTag(el, 'span');
      return;
    }
    replaceTag(el, TAG_MAP[tag] ?? 'section');
  };

  transform(root);
}
