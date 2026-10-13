import katex from 'katex';
import hljs from 'highlight.js';
import type { IRBlock, InlineNode, LayoutIR } from '../ir/types';
import { themeWithOverrides } from './derive';
import type { StyleProps, Theme, ThemeOverrides, ThemeTokens } from './types';

/**
 * applyTheme(ir, theme, overrides?) → 挂好样式的 DOM 容器（§2 theme/）。
 * 预览与导出共用同一渲染态 DOM（§1 铁律 3）：本函数产物即画布 DOM，
 * 也是微信内联快照源、snapdom 截图源。
 */

interface RenderContext {
  doc: Document;
  tokens: ThemeTokens;
  styles: Record<string, StyleProps>;
}

export function applyTheme(
  ir: LayoutIR,
  theme: Theme | string,
  overrides: ThemeOverrides = {},
  doc: Document = globalThis.document,
): HTMLElement {
  if (!doc) throw new Error('@hertz/mdcore: applyTheme 需要 DOM 环境（浏览器或 jsdom）');
  const resolved = themeWithOverrides(theme, overrides);
  const tokens: ThemeTokens = { ...resolved.tokens, ...overrides };
  const styles = resolveStyles(resolved, tokens);
  const ctx: RenderContext = { doc, tokens, styles };

  const container = doc.createElement('section');
  applyProps(container, styles.container);
  container.style.setProperty('font-family', tokens.fontFamily);
  container.style.setProperty('font-size', tokens.fontSize);
  container.style.setProperty('line-height', tokens.lineHeight);

  for (const block of ir) {
    const el = renderBlock(block, ctx);
    if (el) container.appendChild(el);
  }
  return container;
}

/** styles 值中的 `${token}` 占位替换为 overrides 后的 token 字面值（CSS 变量不进产物） */
function resolveStyles(theme: Theme, tokens: ThemeTokens): Record<string, StyleProps> {
  const out: Record<string, StyleProps> = {};
  for (const [key, props] of Object.entries(theme.styles)) {
    const resolvedProps: StyleProps = {};
    for (const [prop, value] of Object.entries(props)) {
      resolvedProps[prop] = value.replace(/\$\{(\w+)\}/g, (_, name: string) => {
        const hit = (tokens as unknown as Record<string, string>)[name];
        return hit ?? value;
      });
    }
    out[key] = resolvedProps;
  }
  return out;
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
  const resolved = themeWithOverrides(theme, overrides);
  const tokens: ThemeTokens = { ...resolved.tokens, ...overrides };
  return resolveStyles(resolved, tokens)[key] ?? {};
}

function applyProps(el: HTMLElement, props: StyleProps | undefined): void {
  if (!props) return;
  for (const [prop, value] of Object.entries(props)) {
    el.style.setProperty(prop, value);
  }
}

function renderBlock(block: IRBlock, ctx: RenderContext): HTMLElement | null {
  const { doc, styles } = ctx;
  switch (block.type) {
    case 'heading': {
      const el = doc.createElement(`h${block.level}`);
      applyProps(el, styles[`h${block.level}`]);
      appendInlines(el, block.children, ctx);
      return el;
    }

    case 'para': {
      const el = doc.createElement('p');
      applyProps(el, styles.para);
      appendInlines(el, block.children, ctx);
      return el;
    }

    case 'list': {
      const el = doc.createElement(block.ordered ? 'ol' : 'ul');
      applyProps(el, styles.list);
      for (const item of block.items) {
        const li = doc.createElement('li');
        applyProps(li, styles.listItem);
        appendInlines(li, item, ctx);
        el.appendChild(li);
      }
      return el;
    }

    case 'code': {
      const pre = doc.createElement('pre');
      applyProps(pre, styles.pre);
      const code = doc.createElement('code');
      applyProps(code, styles.code);
      code.textContent = block.code;
      pre.appendChild(code);
      highlightCode(code, block.lang, ctx);
      return pre;
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
      for (const row of block.rows) {
        const tr = doc.createElement('tr');
        for (const cell of row) {
          const td = doc.createElement('td');
          applyProps(td, styles.td);
          appendInlines(td, cell, ctx);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      return table;
    }

    case 'quote': {
      const el = doc.createElement('blockquote');
      applyProps(el, styles.quote);
      for (const child of block.blocks) {
        const childEl = renderBlock(child, ctx);
        if (childEl) el.appendChild(childEl);
      }
      return el;
    }

    case 'image': {
      const img = doc.createElement('img');
      img.setAttribute('src', block.src);
      img.setAttribute('alt', block.alt);
      applyProps(img, styles.image);
      return img;
    }

    case 'callout': {
      const el = doc.createElement('section');
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

    case 'hr': {
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
      const span = doc.createElement('span');
      span.innerHTML = node.html;
      return span;
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
