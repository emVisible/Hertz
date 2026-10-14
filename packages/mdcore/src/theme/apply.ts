import hljs from 'highlight.js';
import type { IRBlock, IRDiagnostic, InlineNode, LayoutIR, LineRange } from '../ir/types';
import { resolveThemeSlots } from './derive';
import { getTheme } from './index';
import type { ResolvedTokens, StyleProps, Theme, ThemeOverrides } from './types';
import { FORMULA_TEX_ATTR, renderFormula } from './formula';

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
  /**
   * 渲染层诊断：块型命中兜底时记账。
   *
   * 与解析层 `parseToIRDetailed().diagnostics` 对称——两边都有账，才能回答
   * "这篇稿子里有哪些东西我们没真正支持"。
   */
  diagnostics?: IRDiagnostic[];
  tokens: ResolvedTokens;
  styles: Record<string, StyleProps>;
  /** section-number 样式下的章节计数器（CSS counter 不可移植 → 渲染期物化） */
  sections: { n: number };
  /** 当前处在第几层引用（嵌套层级要真的累加，否则 quoteL3 永远是死槽） */
  quoteDepth?: number;
}

/** 纯装饰节点的标记：分页断点二分不能把它当正文切（否则会切进 “ 里） */
const DECO = 'data-mdcore-deco';

/**
 * IR → 渲染态 DOM。
 *
 * `ctx.diagnostics`（如果有传）会收到**渲染层**的未建模记账——与
 * `parseToIRDetailed().diagnostics` 对称。两者合起来才能回答
 * "这篇稿子里有哪些东西我们没真正支持"。
 */
export function applyTheme(
  ir: LayoutIR,
  theme: Theme | string,
  overrides: ThemeOverrides = {},
  doc: Document = globalThis.document,
  diagnostics?: IRDiagnostic[],
): HTMLElement {
  if (!doc) throw new Error('@hertz/mdcore: applyTheme 需要 DOM 环境（浏览器或 jsdom）');
  const { tokens, styles } = resolveThemeSlots(
    typeof theme === 'string' ? getTheme(theme) : theme,
    overrides,
  );
  const ctx: RenderContext = { doc, tokens, styles, sections: { n: 0 }, diagnostics };

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
        applyProps(span, styles.liContent);
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
          applyProps(dots, styles.codeDots);
          for (const c of ['#ff5f57', '#febc2e', '#28c840']) {
            const dot = deco(doc, 'span', 'mdcore-code-dot');
            applyProps(dot, styles.codeDot);
            dot.style.setProperty('background-color', c);
            dots.appendChild(dot);
          }
          head.appendChild(dots);
        }
        // 标签用可读名（文件名优先），高亮用归一化后的语言名——两者不是一回事
        const lang = doc.createElement('span');
        lang.className = 'mdcore-code-lang';
        applyProps(lang, styles.codeLang);
        lang.textContent = block.label ?? block.lang ?? '';
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
      /**
       * 窄表横滚：块元素是一层 `.mdcore-table-wrap`（overflow-x:auto），table 放里面。
       *
       * 为什么不能直接给 table 加 overflow：display:table 的元素上 overflow 与
       * border-radius 基本无效（不产生 BFC），单元格会被压扁/逐字折行，用户宁可
       * 横着滚也不要看到"第一列五个字换三行"。包一层是唯一可靠的做法。
       *
       * 代价：分页里 `matches('table')` 的判断必须跟着改（见 paginate 的 tableOf）。
       */
      const wrap = doc.createElement('div');
      wrap.className = 'mdcore-table-wrap';
      applyProps(wrap, styles.tableWrap);
      const table = doc.createElement('table');
      table.className = 'mdcore-table';
      applyProps(table, styles.table);
      // 按列：一列一个值，作用于该列所有单元格
      const alignAt = (colIndex: number): string | null => block.align?.[colIndex] ?? null;
      const thead = doc.createElement('thead');
      const headTr = doc.createElement('tr');
      block.header.forEach((cell, colIndex) => {
        const th = doc.createElement('th');
        applyProps(th, styles.th);
        applyProps(th, styles.tableCell);
        const align = alignAt(colIndex);
        if (align) th.style.setProperty('text-align', align);
        // 表头圆角只能逐格写死：产物里没有 <style>，`thead th:first-child` 那条
        // 规则在导出快照与剪贴板内联里都不生效
        if (colIndex === 0) {
          th.classList.add('mdcore-th-first');
          applyProps(th, styles.thFirst);
        }
        if (colIndex === block.header.length - 1) {
          th.classList.add('mdcore-th-last');
          applyProps(th, styles.thLast);
        }
        appendInlines(th, cell, ctx);
        headTr.appendChild(th);
      });
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
        row.forEach((cell, colIndex) => {
          const td = doc.createElement('td');
          applyProps(td, styles.td);
          applyProps(td, styles.tableCell);
          const align = alignAt(colIndex);
          if (align) td.style.setProperty('text-align', align);
          appendInlines(td, cell, ctx);
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      wrap.appendChild(table);
      return wrap;
    }

    case 'quote': {
      const el = doc.createElement('blockquote');
      const depth = ctx.quoteDepth ?? 0;
      // 层级样式按**真实嵌套深度**选，而不是按子块下标。
      // 早先是 `i > 0 && child.type === 'quote' ? 2 : 0`：只产出 0 与 2，三层引用与
      // 两层长得一模一样，`quoteL3` 这个槽**永远不会被写**（死槽）。
      if (depth === 1) {
        el.classList.add('mdcore-quote-l2');
        applyProps(el, styles.quoteL2 ?? {});
      } else if (depth >= 2) {
        el.classList.add('mdcore-quote-l2');
        el.classList.add('mdcore-quote-l3');
        applyProps(el, styles.quoteL3 ?? {});
      } else {
        applyProps(el, styles.quote);
      }
      const childCtx: RenderContext = { ...ctx, quoteDepth: depth + 1 };
      for (const child of block.blocks) {
        const childEl = renderBlock(child, childCtx);
        if (!childEl) continue;
        el.appendChild(childEl);
      }
      if (tokens.quoteStyle === 'quote-mark') {
        const mark = deco(doc, 'span', 'mdcore-quote-mark');
        mark.textContent = '\u201c';
        applyProps(mark, styles.quoteMark);
        el.insertBefore(mark, el.firstChild);
      }
      return el;
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
      el.className = 'mdcore-formula';
      el.setAttribute(FORMULA_TEX_ATTR, block.tex);
      applyProps(el, styles.formula);
      el.innerHTML = renderFormula(block.tex, block.displayMode, { doc }).html;
      return el;
    }

    case 'deflist': {
      // 定义列表：术语行 + 缩进释义。术语用粗体（比 <dt> 默认样式更像中文的"词条"）
      const dl = doc.createElement('dl');
      dl.className = 'mdcore-deflist';
      applyProps(dl, styles.deflist);
      for (const item of block.items) {
        const dt = doc.createElement('dt');
        dt.className = 'mdcore-def-term';
        applyProps(dt, styles.defTerm);
        for (const node of item.term) dt.appendChild(renderInline(node, ctx));
        dl.appendChild(dt);
        for (const def of item.defs) {
          const dd = doc.createElement('dd');
          dd.className = 'mdcore-def-def';
          applyProps(dd, styles.defDef);
          for (const node of def) dd.appendChild(renderInline(node, ctx));
          dl.appendChild(dd);
        }
      }
      return dl;
    }

    case 'footnotes': {
      // 文末脚注区：一条细横线 + 编号条目，角标可回跳
      const area = doc.createElement('section');
      area.className = 'mdcore-footnotes';
      applyProps(area, styles.footnoteArea);
      block.items.forEach((item) => {
        const row = doc.createElement('p');
        row.className = 'mdcore-footnote-item';
        row.id = `mdcore-fn-${item.id}`;
        applyProps(row, styles.footnoteItem);
        const num = doc.createElement('span');
        num.className = 'mdcore-footnote-num';
        applyProps(num, styles.footnoteNum);
        num.textContent = `[${item.label || item.id + 1}]`;
        row.appendChild(num);
        for (const inner of item.blocks) {
          const rendered = renderBlock(inner, ctx);
          if (rendered) row.appendChild(rendered);
        }
        area.appendChild(row);
      });
      return area;
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
      // `---`（pagebreak）在连续长文里仍然是一条横线；卡片平台把它当换页信号。
      // 标记必须**两个分支都加**：早先只加在 <hr> 那条路上，而小红书三套主题用的
      // 全是 dots 样式（走三圆点分支），于是 `---` 在小红书上静默失效——
      // 正是「小红书完全不可用」清单里没被单独列出来的那一条。
      let el: HTMLElement;
      if (tokens.hrStyle === 'dots') {
        el = deco(doc, 'section', 'mdcore-hr-dots');
        applyProps(el, styles.hr);
        for (let i = 0; i < 3; i += 1) {
          const dot = deco(doc, 'span', 'mdcore-hr-dot');
          applyProps(dot, styles.hrDot);
          el.appendChild(dot);
        }
      } else {
        el = doc.createElement('hr');
        applyProps(el, styles.hr);
      }
      if (block.kind === 'pagebreak') {
        el.classList.add('mdcore-pagebreak');
        el.setAttribute('data-mdcore-pagebreak', 'true');
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

    default: {
      /**
       * 未建模的块型：**记账 + 可见降级**，不静默吞。
       *
       * 解析层早就有 diagnostics（切片 1），而渲染层的兜底是 `return null`——
       * 两边不对称：将来新增一个 IR 块型却忘了写渲染分支，正文会**悄悄少一块**，
       * 结构断言还可能因为"少了一块"而全绿。
       */
      // 顺带说一句：TS 会把这里的 `block` 收窄成 `never`——也就是说
      // **新增一个 IR 块型却忘了写渲染分支，编译就会报错**。那是第一道防线；
      // 这一层是第二道（给绕过类型断言的路径兜底：至少内容不能消失）。
      const unknown = block as unknown as { type: string; line?: LineRange | null };
      ctx.diagnostics?.push({ token: `render:${unknown.type}`, count: 1, line: unknown.line?.[0] ?? null });
      return fallbackFor(block, ctx);
    }
  }
}

/**
 * 兜底渲染：未建模的块型也要**产出可见的东西**。
 *
 * 能取到纯文本的（段落/列表/表格单元格）退化成一段文字；取不到的（无文本的
 * 结构件）返回 null——那才是"这里本来就没有内容"，返回 null 不会让正文少东西。
 */
function fallbackFor(block: IRBlock, ctx: RenderContext): HTMLElement | null {
  const { doc } = ctx;
  const text = (() => {
    const b = block as unknown as Record<string, unknown>;
    if ('children' in b) return inlineToText(b.children as InlineNode[]);
    if (b.type === 'code') return String(b.code ?? '');
    if (b.type === 'image') return String(b.alt ?? '');
    return '';
  })();
  if (!text.trim()) return null;
  const p = doc.createElement('p');
  p.className = 'mdcore-fallback';
  p.setAttribute('data-mdcore-fallback', block.type);
  p.textContent = text;
  return p;
}

function inlineToText(nodes: InlineNode[]): string {
  return nodes
    .map((n) => {
      switch (n.type) {
        case 'text':
        case 'code':
          return n.text;
        case 'tag':
          return `#${n.text}`;
        case 'image':
          return n.alt;
        case 'formula':
          return n.tex;
        case 'html':
          return n.html.replace(/<[^>]+>/g, '');
        case 'break':
          return '\n';
        case 'strong':
        case 'em':
        case 'mark':
        case 'sub':
        case 'sup':
        case 'link':
          return inlineToText(n.children);
        case 'ruby':
          return inlineToText(n.base);
        default:
          return '';
      }
    })
    .join('');
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
      /**
       * 行内图此前复用**块级** `image` 槽，而那个槽带 `display:block; margin:0 auto`——
       * 于是段内插一张图，整段被撑成块级并居中，图文流彻底断掉。
       * 现在行内图有自己的槽（inline 默认），尺寸/对齐与块级同一套记号。
       */
      const img = doc.createElement('img');
      img.setAttribute('src', node.src);
      img.setAttribute('alt', node.alt);
      applyProps(img, styles.imageInline);
      if (node.width) {
        img.style.setProperty('width', node.width);
        img.style.setProperty('max-width', '100%');
      }
      if (node.align) {
        img.style.setProperty('margin-left', node.align === 'right' ? 'auto' : '0');
        img.style.setProperty('margin-right', node.align === 'left' ? 'auto' : '0');
      }
      return img;
    }

    case 'formula': {
      // 行内公式此前是「裸 span + 零样式」：字号、基线、颜色全由 KaTeX CSS 决定，
      // 而那份 CSS 当时全仓无人引入，于是行内公式在产物里就是一团没排版的字符。
      // 现在它有自己的槽（formulaInline），主题管得到。
      const span = doc.createElement('span');
      span.className = 'mdcore-formula-inline';
      span.setAttribute(FORMULA_TEX_ATTR, node.tex);
      applyProps(span, styles.formulaInline);
      span.innerHTML = renderFormula(node.tex, node.displayMode, { doc }).html;
      return span;
    }

    case 'html': {
      // 整段就是一个带样式的 span 时直接用它，别再套一层（产物里多一个空 span
      // 既是噪音，也会让微信内联多算一次样式）
      const single = /^\s*<span\b[^>]*>\s*[\s\S]*\s*<\/span>\s*$/i.test(node.html);
      if (single) {
        // 整段就是一个 span 时**直接用它**，别再套一层（产物里多一个空 span
        // 既是噪音，也会让微信内联多算一次样式）
        const holder = doc.createElement('div');
        holder.innerHTML = node.html;
        const el = holder.firstElementChild;
        if (el) {
          holder.removeChild(el);
          // `[color:#xxx]` 走的就是这条路：把彩色文字槽合并进它自己，
          // 作者写一个色值之后主题仍管得到（而不是另包一层 span）
          // 判断看**整个属性串**而不是只找 `style="`：经过内联清洗后 class 上的
          // 样式会变成 `class="..."`，内联色值也可能被排在属性串后半段
          if (el instanceof HTMLElement && /(^|;)\s*color\s*:/i.test(el.getAttribute('style') ?? '')) {
            el.classList.add('mdcore-colored');
            for (const [prop, value] of Object.entries(styles.coloredText ?? {})) {
              if (!el.style.getPropertyValue(prop)) el.style.setProperty(prop, value);
            }
          }
          return el;
        }
      }
      const span = doc.createElement('span');
      applyProps(span, styles.coloredText);
      span.innerHTML = node.html;
      return span;
    }

    case 'footnoteRef': {
      // 角标：上标 + 可点回跳（微信清洗器会留 <sup>/<a>，不依赖任何伪元素）
      const sup = doc.createElement('sup');
      sup.className = 'mdcore-footnote-ref';
      const link = doc.createElement('a');
      link.setAttribute('href', `#mdcore-fn-${node.id}`);
      link.textContent = String(node.id + 1);
      applyProps(link, styles.footnoteRef);
      sup.appendChild(link);
      applyProps(sup, styles.footnoteRef);
      return sup;
    }

    case 'tag': {
      // #话题：颜色跟主色（小红书里话题就是品牌色），且不可点（平台直发不做）
      const el = doc.createElement('span');
      el.className = 'mdcore-tag';
      applyProps(el, styles.tag);
      el.textContent = `#${node.text}`;
      return el;
    }

    case 'break': {
      const br = doc.createElement('br');
      applyProps(br, styles.br);
      return br;
    }
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