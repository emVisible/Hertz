import katex from 'katex';
import hljs from 'highlight.js';
import type { IRBlock, InlineNode, LayoutIR } from '../ir/types';
import { resolveThemeSlots } from './derive';
import { getTheme } from './index';
import type { ResolvedTokens, StyleProps, Theme, ThemeOverrides } from './types';

/**
 * applyTheme(ir, theme, overrides) → 挂好样式的 DOM 容器（§2 theme/）。
 * 预览与导出共用同一渲染态 DOM（§1 铁律 3）：本函数产物即画布 DOM，
 * 也是微信内联快照源、snapdom 截图源。
 *
 * v0.36 的排版规矩（三条，都会影响产物结构，所以写在这里而不是设计文档里）：
 *
 * 1. **装饰一律真元素，不用伪元素**。微信清洗器剥 `<style>`，而我们的内联走
 *    `getComputedStyle` —— 伪元素的 content/背景永远读不出来。也就是说
 *    `h2::before { content: '01' }` 在公众号里就是没有。所以：编号、列表符号、
 *    三圆点分隔线、引用大引号全部是**渲染期物化出来的真实节点**（带
 *    `data-mdcore-deco`），三个平台都带着。
 * 2. **em 化节奏**。段距/章节距是 em，字号一改间距跟着缩放（px 间距在 30px 的
 *    小红书卡片与 16px 的微信正文上是两套比例）。
 * 3. **标题装饰分两处挂**。撑满整行的（左边条/下划线/药丸/双线）挂 `<h*>`；
 *    贴着文字的（荧光笔渐变）挂 `<span class="mdcore-h-content">` 并配
 *    `box-decoration-break: clone`——否则标题折行时渐变只染第一行。
 */

interface RenderContext {
  doc: Document;
  tokens: ResolvedTokens;
  styles: Record<string, StyleProps>;
  /** section-number 样式下的章节计数器（CSS counter 不可移植 → 渲染期物化） */
  sections: { n: number };
}

/** 纯装饰节点的标记：分页断点二分不能把它当正文切（否则会切进 “ 里） */
const DECO = 'data-mdcore-deco';

export function applyTheme(
  ir: LayoutIR,
  theme: Theme | string,
  overrides: ThemeOverrides = {},
  doc: Document = globalThis.document,
): HTMLElement {
  if (!doc) throw new Error('@hertz/mdcore: applyTheme 需要 DOM 环境（浏览器或 jsdom）');
  const { tokens, styles } = resolveThemeSlots(
    typeof theme === 'string' ? getTheme(theme) : theme,
    overrides,
  );
  const ctx: RenderContext = { doc, tokens, styles, sections: { n: 0 } };

  const container = doc.createElement('section');
  container.className = 'mdcore-doc';
  applyProps(container, styles.container);
  container.style.setProperty('font-family', tokens.fontFamily);
  container.style.setProperty('font-size', tokens.fontSize);
  container.style.setProperty('line-height', tokens.lineHeight);
  container.style.setProperty('letter-spacing', tokens.letterSpacing);
  if (!styles.container?.['background-color']) {
    container.style.setProperty('background-color', tokens.canvasBg);
  }
  container.style.setProperty('color', tokens.ink);
  // 中文断行三条：标点不开行首（避头尾）、长串不撑破、正常文本不孤字
  container.style.setProperty('line-break', 'strict');
  container.style.setProperty('word-break', 'break-word');
  container.style.setProperty('overflow-wrap', 'break-word');

  for (const [index, block] of ir.entries()) {
    const el = renderBlock(block, ctx);
    if (!el) continue;
    // 块定位标记：画布靠它把「点到的段落」与「分页边界」映射回 IR 序号与源码行号。
    // 只标顶层块——嵌套在引用/callout 里的子块不参与画布交互。
    el.setAttribute('data-mdcore-block', String(index));
    if (block.line) el.setAttribute('data-mdcore-line', `${block.line[0]}-${block.line[1]}`);
    container.appendChild(el);
  }
  return container;
}

/**
 * 解析某个 style 键（含 ${token} 替换）—— 供 paginate/xhs 给页壳、页脚等非 IR 元素
 * 挂主题样式（卡片 card / 品牌页脚 cardFooter 等键位）。
 */
export function resolveThemedProps(
  theme: Theme | string,
  overrides: ThemeOverrides,
  key: string,
): StyleProps {
  const { styles } = resolveThemeSlots(typeof theme === 'string' ? getTheme(theme) : theme, overrides);
  return styles[key] ?? {};
}

function applyProps(el: HTMLElement, props: StyleProps | undefined): void {
  if (!props) return;
  for (const [prop, value] of Object.entries(props)) {
    el.style.setProperty(prop, value);
  }
}

/** 装饰节点：带 deco 标记 + aria-hidden，微信/分页/读屏都当它不存在 */
function deco(doc: Document, tag: 'span' | 'section', className: string): HTMLElement {
  const el = doc.createElement(tag);
  el.className = className;
  el.setAttribute(DECO, '');
  el.setAttribute('aria-hidden', 'true');
  return el;
}

/** 中文数字序号（一 二 三 … 十、十一…），给 cjk-numeral 列表用 */
export function cjkNumeral(n: number): string {
  const digits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  if (n <= 0) return digits[0];
  if (n < 10) return digits[n];
  if (n === 10) return '十';
  if (n < 20) return `十${digits[n - 10]}`;
  if (n < 100) {
    const tens = Math.floor(n / 10);
    const ones = n % 10;
    return `${digits[tens]}十${ones ? digits[ones] : ''}`;
  }
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (rest === 0) return `${digits[hundreds]}百`;
  const restText = rest < 10 ? `零${digits[rest]}` : cjkNumeral(rest);
  return `${digits[hundreds]}百${restText}`;
}

function renderBlock(block: IRBlock, ctx: RenderContext): HTMLElement | null {
  const { doc, styles, tokens } = ctx;
  switch (block.type) {
    case 'heading': {
      const el = doc.createElement(`h${block.level}`);
      applyProps(el, styles[`h${block.level}`]);
      // 章节节奏：标题前距比段距大一档，且用 em（字号改大时跟着缩放）
      el.style.setProperty('margin-top', tokens.sectionSpacing);
      const prefix = deco(doc, 'span', 'mdcore-h-prefix');
      applyProps(prefix, styles.headingPrefix);
      if (tokens.headingStyle === 'section-number' && block.level === 2) {
        ctx.sections.n += 1;
        prefix.textContent = String(ctx.sections.n).padStart(2, '0');
      }
      const content = doc.createElement('span');
      content.className = 'mdcore-h-content';
      applyProps(content, styles.headingContent);
      appendInlines(content, block.children, ctx);
      el.appendChild(prefix);
      el.appendChild(content);
      return el;
    }

    case 'para': {
      const el = doc.createElement('p');
      applyProps(el, styles.para);
      // 节奏 token 直接落到元素上：改 paraSpacing 必须看得见（主题里没写 margin 也要生效）
      el.style.setProperty('margin-bottom', tokens.paraSpacing);
      if (tokens.indent !== '0') el.style.setProperty('text-indent', tokens.indent);
      if (tokens.measure !== 'none') el.style.setProperty('max-width', tokens.measure);
      // 正文两端对齐 + 避免孤字尾行（微信/小红书正文观感提升最省事的一处）
      if (tokens.align === 'justify') {
        el.style.setProperty('text-align', 'justify');
        el.style.setProperty('text-justify', 'inter-ideograph');
      }
      el.style.setProperty('text-wrap', 'pretty');
      appendInlines(el, block.children, ctx);
      return el;
    }

    case 'list': {
      const el = doc.createElement(block.ordered ? 'ol' : 'ul');
      applyProps(el, styles.list);
      // 自绘序号 → 关掉浏览器 marker（否则两套符号叠着；微信扁平化时它也会被补一个前缀）
      el.style.setProperty('list-style', 'none');
      el.style.setProperty('padding-left', tokens.paraSpacing);
      const numeral = tokens.listStyle === 'cjk-numeral';
      block.items.forEach((item, i) => {
        const li = doc.createElement('li');
        applyProps(li, styles.listItem);
        const marker = doc.createElement('span');
        marker.className = 'mdcore-marker';
        applyProps(marker, styles.listMarker);
        marker.textContent = numeral
          ? cjkNumeral(i + 1)
          : block.ordered
            ? `${i + 1}.`
            : '•';
        li.appendChild(marker);
        const span = doc.createElement('span');
        span.className = 'mdcore-li-content';
        appendInlines(span, item, ctx);
        li.appendChild(span);
        el.appendChild(li);
      });
      return el;
    }

    case 'code': {
      // 代码卡片：头部（语言标签 / Mac 三色点）+ 代码体。
      // 为什么要包一层：语言标签与卡片圆角是"排版"，不是"代码"；不包就没地方挂。
      const wrap = doc.createElement('section');
      wrap.className = 'mdcore-code';
      applyProps(wrap, styles.codeCard);
      if (tokens.codeBar !== 'none') {
        const head = doc.createElement('div');
        head.className = 'mdcore-code-head';
        applyProps(head, styles.codeHead);
        if (tokens.codeBar === 'mac') {
          const dots = deco(doc, 'span', 'mdcore-code-dots');
          for (const c of ['#ff5f57', '#febc2e', '#28c840']) {
            const dot = doc.createElement('span');
            dot.className = 'mdcore-code-dot';
            dot.style.setProperty('background-color', c);
            dots.appendChild(dot);
          }
          head.appendChild(dots);
        }
        const lang = doc.createElement('span');
        lang.className = 'mdcore-code-lang';
        applyProps(lang, styles.codeLang);
        lang.textContent = block.lang ?? '';
        head.appendChild(lang);
        wrap.appendChild(head);
      }
      const pre = doc.createElement('pre');
      applyProps(pre, styles.pre);
      const code = doc.createElement('code');
      applyProps(code, styles.code);
      code.textContent = block.code;
      pre.appendChild(code);
      wrap.appendChild(pre);
      highlightCode(code, block.lang, ctx);
      return wrap;
    }

    case 'table': {
      const table = doc.createElement('table');
      applyProps(table, styles.table);
      const thead = doc.createElement('thead');
      const headTr = doc.createElement('tr');
      for (const cell of block.header) {
        const th = doc.createElement('th');
        applyProps(th, styles.th);
        appendInlines(th, cell, ctx);
        headTr.appendChild(th);
      }
      thead.appendChild(headTr);
      table.appendChild(thead);
      const tbody = doc.createElement('tbody');
      block.rows.forEach((row, rowIndex) => {
        const tr = doc.createElement('tr');
        // 斑马纹只能逐行写死：产物里没有 <style>，nth-child 那条规则不存在
        if (rowIndex % 2 === 1) {
          tr.className = 'mdcore-row-even';
          applyProps(tr, styles.tbodyEven);
        }
        for (const cell of row) {
          const td = doc.createElement('td');
          applyProps(td, styles.td);
          appendInlines(td, cell, ctx);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      return table;
    }

    case 'quote': {
      const el = doc.createElement('blockquote');
      applyProps(el, styles.quote);
      // 嵌套层级：引用套引用要有层级差（参考仓库 multiquote-N 的做法）
      block.blocks.forEach((child, i) => {
        const childEl = renderBlock(child, ctx);
        if (!childEl) return;
        const depth = i > 0 && child.type === 'quote' ? 2 : 0;
        if (depth) {
          childEl.classList.add('mdcore-quote-l2');
          applyProps(childEl, styles.quoteL2 ?? {});
        }
        el.appendChild(childEl);
      });
      if (tokens.quoteStyle === 'quote-mark') {
        const mark = deco(doc, 'span', 'mdcore-quote-mark');
        applyProps(mark, styles.quoteMark);
        mark.textContent = '“';
        el.insertBefore(mark, el.firstChild);
      }
      return el;
    }

    case 'image': {
      const figure = doc.createElement('figure');
      figure.className = 'mdcore-figure';
      applyProps(figure, styles.figure);
      const img = doc.createElement('img');
      img.setAttribute('src', block.src);
      img.setAttribute('alt', block.alt);
      applyProps(img, styles.image);
      // `{60% left}` 覆盖：宽度与对齐（小红书排版件；不给就用主题默认）
      if (block.width) {
        img.style.setProperty('width', block.width);
        img.style.setProperty('max-width', '100%');
        // 对齐是三个互斥取值：**逐项写死**而不是"先 auto 再改一个"——
        // 后者会留下上一次的对齐值（左对齐时 margin-left 仍停在 auto）
        img.style.setProperty('margin-left', block.align === 'right' ? 'auto' : '0');
        img.style.setProperty('margin-right', block.align === 'left' ? 'auto' : '0');
        figure.style.setProperty('width', block.width);
      }
      figure.appendChild(img);
      // alt 作图注：有图注才生成figcaption（空 alt 不占位）
      if (block.alt && styles.figcaption) {
        const cap = doc.createElement('figcaption');
        applyProps(cap, styles.figcaption);
        cap.textContent = block.alt;
        figure.appendChild(cap);
      }
      return figure;
    }

    case 'callout': {
      const el = doc.createElement('section');
      el.className = `mdcore-callout mdcore-callout-${block.variant}`;
      applyProps(el, styles.callout);
      applyProps(el, styles[`callout-${block.variant}`]);
      for (const child of block.blocks) {
        const childEl = renderBlock(child, ctx);
        if (childEl) el.appendChild(childEl);
      }
      return el;
    }

    case 'formula': {
      const el = doc.createElement('section');
      applyProps(el, styles.formula);
      el.innerHTML = katex.renderToString(block.tex, {
        displayMode: block.displayMode,
        throwOnError: false,
      });
      return el;
    }

    case 'toc': {
      // 目录：两级（H2/H3）缩进列表。微信把 <nav> 拍平，所以这里用 section/p 造
      const box = doc.createElement('section');
      box.className = 'mdcore-toc';
      applyProps(box, styles.toc);
      if (!block.items.length) {
        const empty = doc.createElement('p');
        empty.className = 'mdcore-toc-empty';
        empty.textContent = '（本文还没有 2/3 级标题）';
        applyProps(empty, styles.tocEmpty);
        box.appendChild(empty);
      }
      block.items.forEach((item) => {
        const row = doc.createElement('p');
        row.className = `mdcore-toc-item mdcore-toc-l${item.level}`;
        applyProps(row, styles.tocItem);
        if (item.level === 3) row.style.setProperty('padding-left', '1.2em');
        const link = doc.createElement('a');
        link.setAttribute('href', `#${item.anchor}`);
        link.textContent = item.text;
        applyProps(link, styles.tocLink);
        row.appendChild(link);
        box.appendChild(row);
      });
      return box;
    }

    case 'hr': {
      if (tokens.hrStyle === 'dots') {
        const el = deco(doc, 'section', 'mdcore-hr-dots');
        applyProps(el, styles.hr);
        for (let i = 0; i < 3; i += 1) {
          const dot = deco(doc, 'span', 'mdcore-hr-dot');
          applyProps(dot, styles.hrDot);
          el.appendChild(dot);
        }
        return el;
      }
      const el = doc.createElement('hr');
      applyProps(el, styles.hr);
      return el;
    }

    default:
      return null;
  }
}

function appendInlines(parent: HTMLElement, children: InlineNode[], ctx: RenderContext): void {
  for (const node of children) {
    parent.appendChild(renderInline(node, ctx));
  }
}

function renderInline(node: InlineNode, ctx: RenderContext): Node {
  const { doc, styles } = ctx;
  switch (node.type) {
    case 'text':
      return doc.createTextNode(node.text);

    case 'strong': {
      const el = doc.createElement('strong');
      applyProps(el, styles.strong);
      appendInlines(el, node.children, ctx);
      return el;
    }

    case 'em': {
      const el = doc.createElement('em');
      applyProps(el, styles.em);
      appendInlines(el, node.children, ctx);
      return el;
    }

    case 'mark': {
      // `==高亮==`：底色来自 mark 槽（派生给 hl）。cross-break 让高亮跨行不断开
      const el = doc.createElement('mark');
      applyProps(el, styles.mark);
      appendInlines(el, node.children, ctx);
      return el;
    }

    case 'sub':
    case 'sup': {
      const tag = node.type === 'sub' ? 'sub' : 'sup';
      const el = doc.createElement(tag);
      applyProps(el, node.type === 'sub' ? styles.sub : styles.sup);
      appendInlines(el, node.children, ctx);
      return el;
    }

    case 'ruby': {
      // 注音：base + rt（rt 用真正的 <rt>，微信清洗器不剥）
      const el = doc.createElement('ruby');
      applyProps(el, styles.ruby);
      appendInlines(el, node.base, ctx);
      const rt = doc.createElement('rt');
      applyProps(rt, styles.rubyRt);
      appendInlines(rt, node.rt, ctx);
      el.appendChild(rt);
      return el;
    }

    case 'code': {
      const el = doc.createElement('code');
      applyProps(el, styles.inlineCode);
      el.textContent = node.text;
      return el;
    }

    case 'link': {
      const el = doc.createElement('a');
      el.setAttribute('href', node.href);
      applyProps(el, styles.link);
      appendInlines(el, node.children, ctx);
      return el;
    }

    case 'image': {
      const img = doc.createElement('img');
      img.setAttribute('src', node.src);
      img.setAttribute('alt', node.alt);
      applyProps(img, styles.image);
      return img;
    }

    case 'formula': {
      const span = doc.createElement('span');
      span.innerHTML = katex.renderToString(node.tex, {
        displayMode: node.displayMode,
        throwOnError: false,
      });
      return span;
    }

    case 'html': {
      // 整段就是一个带样式的 span 时直接用它，别再套一层（产物里多一个空 span
      // 既是噪音，也会让微信内联多算一次样式）
      const single = /^\s*<span\b[^>]*>\s*[\s\S]*\s*<\/span>\s*$/i.test(node.html);
      if (single) {
        const holder = doc.createElement('div');
        holder.innerHTML = node.html;
        const el = holder.firstElementChild;
        if (el) {
          holder.removeChild(el);
          return el;
        }
      }
      const span = doc.createElement('span');
      span.innerHTML = node.html;
      return span;
    }

    case 'tag': {
      // #话题：颜色跟主色（小红书里话题就是品牌色），且不可点（平台直发不做）
      const el = doc.createElement('span');
      el.className = 'mdcore-tag';
      applyProps(el, styles.tag);
      el.textContent = `#${node.text}`;
      return el;
    }

    case 'break':
      return doc.createElement('br');
  }
}

/**
 * 代码高亮：IR 只存源码，高亮属于渲染关注，故在 applyTheme 阶段用
 * highlight.js 同步重跑，并把产物的 hljs-* class 映射为主题 styles['hljs-*']
 * 的内联颜色 —— 微信清洗器剥 class，颜色必须落 style。
 */
function highlightCode(codeEl: HTMLElement, lang: string | null, ctx: RenderContext): void {
  if (!lang || !hljs.getLanguage(lang)) return;
  let html: string;
  try {
    html = hljs.highlight(codeEl.textContent ?? '', { language: lang }).value;
  } catch {
    return; // 高亮失败降级为纯文本
  }
  codeEl.innerHTML = html;
  for (const span of Array.from(codeEl.querySelectorAll('span[class]'))) {
    for (const cls of Array.from(span.classList)) {
      const props = ctx.styles[cls];
      if (props) applyProps(span as HTMLElement, props);
    }
  }
}