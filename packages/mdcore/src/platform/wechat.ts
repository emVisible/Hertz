/**
 * 微信适配器（§3.1 wechat）。
 *
 * 参考声明：本文件的「清洗器对抗」思路（渲染态 getComputedStyle 快照内联、
 * pre 空格/Tab → &nbsp;、pre overflow-x:auto、mjx-container → section、
 * 外链转脚注、结构扁平化为 section/p/span、剥 class/id/<style>）
 * 参考了 mdsea/WeMD（MIT License）的规则清单与实践经验，代码为本仓库重写，
 * 未整段复制；致谢 WeMD 作者（MIT）。
 *
 * 输入：渲染态画布 DOM（applyTheme 产物）或其 ownerDocument。
 * 输出：{ html, text } 剪贴板 payload + copyToClipboard。
 *
 * 共享层：快照内联/代码块硬化/剥除/序列化/剪贴板双写已抽至 platform/inline.ts
 * （知乎 §3.2 复用同规格基础件）；本文件保留微信专有步骤（外链转脚注、扁平化映射）。
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

export { copyToClipboard } from './inline';

export interface WechatPayload {
  html: string;
  text: string;
}

/** 微信安全标签：保留原样 */
const KEEP_TAGS = new Set([
  'SECTION',
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
  'TABLE',
  'THEAD',
  'TBODY',
  'TR',
  'TD',
  'TH',
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

/** 结构扁平化映射：块级 → section/p，行内降级 → span/strong/em */
const TAG_MAP: Record<string, string> = {
  // 行内语义降级
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
  A: 'span', // 剩余非 http 链接（锚点/相对链接）剥 href
  // 块级一律 section/p
  DIV: 'section',
  ARTICLE: 'section',
  ASIDE: 'section',
  HEADER: 'section',
  FOOTER: 'section',
  NAV: 'section',
  MAIN: 'section',
  BLOCKQUOTE: 'section',
  FIGURE: 'section',
  FIGCAPTION: 'p',
  DL: 'section',
  DT: 'p',
  DD: 'p',
  DETAILS: 'section',
  SUMMARY: 'p',
  UL: 'section',
  OL: 'section',
  // MathJax 容器（防御：katex 之外的公式引擎产物）
  'MJX-CONTAINER': 'section',
};

/**
 * 渲染态 DOM → 微信剪贴板 payload。
 * 不改动入参 DOM：全程在深克隆上操作。
 */
export function toWechatClipboardPayload(input: Document | HTMLElement): WechatPayload {
  const { clone, win, cleanup } = snapshotClone(input, 'wechatPayload');
  try {
    inlineComputedStyles(clone, win);
    hardenCodeBlocks(clone);
    linksToFootnotes(clone);
    flattenStructure(clone);
    stripUnsafe(clone);
    panguSpacingDOM(clone);

    return { html: clone.innerHTML, text: normalizeText(clone) };
  } finally {
    cleanup();
  }
}

/** 外链转脚注 —— 微信禁外链：<a href=http(s)> → 上号角标 + 文末 References */
function linksToFootnotes(root: HTMLElement): void {
  const doc = root.ownerDocument;
  const refs: string[] = [];
  for (const a of Array.from(root.querySelectorAll('a[href]'))) {
    const href = a.getAttribute('href') ?? '';
    if (!/^https?:\/\//i.test(href)) continue;
    refs.push(href);
    const sup = doc.createElement('sup');
    sup.textContent = `[${refs.length}]`;
    sup.setAttribute('style', 'font-size:12px;line-height:0;');
    const span = doc.createElement('span');
    while (a.firstChild) span.appendChild(a.firstChild);
    const frag = doc.createDocumentFragment();
    frag.appendChild(span);
    frag.appendChild(sup);
    a.replaceWith(frag);
  }
  if (refs.length === 0) return;

  const section = doc.createElement('section');
  section.setAttribute('style', 'margin-top:32px;');
  const title = doc.createElement('p');
  const strong = doc.createElement('strong');
  strong.textContent = 'References';
  title.appendChild(strong);
  section.appendChild(title);
  refs.forEach((href, idx) => {
    const p = doc.createElement('p');
    p.setAttribute('style', 'font-size:12px;word-break:break-all;');
    p.textContent = `[${idx + 1}] ${href}`;
    section.appendChild(p);
  });
  root.appendChild(section);
}

/** 结构扁平化 —— 块级一律 section/p/span/strong/em/img 等微信安全标签 */
function flattenStructure(root: HTMLElement): void {
  const doc = root.ownerDocument;

  const transform = (el: Element): void => {
    // 后序：先处理子树，再处理自身（LI 需要看到尚未被映射的 UL/OL 父级）
    for (const child of Array.from(el.children)) transform(child);
    if (el === root) return;

    const tag = el.tagName;
    if (KEEP_TAGS.has(tag)) return;
    if (DROP_TAGS.has(tag)) {
      el.remove();
      return;
    }
    if (tag === 'LI') {
      const parent = el.parentElement;
      const ordered = parent?.tagName === 'OL';
      const idx = parent ? Array.from(parent.children).filter((c) => c.tagName === 'LI').indexOf(el) : 0;
      const p = doc.createElement('p');
      for (const attr of Array.from(el.attributes)) p.setAttribute(attr.name, attr.value);
      p.appendChild(doc.createTextNode(ordered ? `${idx + 1}. ` : '• '));
      while (el.firstChild) p.appendChild(el.firstChild);
      el.replaceWith(p);
      return;
    }
    replaceTag(el, TAG_MAP[tag] ?? 'section');
  };

  transform(root);
}
