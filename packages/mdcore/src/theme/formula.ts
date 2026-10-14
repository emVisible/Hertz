/**
 * 公式渲染层（v0.36，W1 切片 1）。
 *
 * 这一层存在的理由是一条**此前完全没人负责**的事：KaTeX 产出的 HTML 依赖
 * `katex/dist/katex.min.css` 里的 class 规则（`.katex` / `.katex-display` /
 * `.frac-line` …）以及它自带的 `@font-face`。那份 CSS 全仓从未被引入过——
 * 于是"支持公式"这件事在产物里从来不成立：正文里只剩一堆没有布局的 span。
 *
 * 两条约定：
 * 1. **CSS 缺失必须看得见**。`katexCssMissing()` 在渲染前查一次，缺失时**不静默**：
 *    改用「可读文本 + 源码提示」的回落形态，而不是给用户一个塌掉的公式。
 * 2. **渲染失败也要看得见**。`throwOnError:false` 时 KaTeX 会吐一个自带红字的
 *    `katex-error` span，那个红字跟着主题走会很难看；这里统一换成自己的回落形态：
 *    等宽源码 + 失败提示，作者能看懂自己写错了什么。
 */
import katex from 'katex';

export interface FormulaRender {
  /** 注入 DOM 的 HTML */
  html: string;
  /** 是否走了回落形态（CSS 缺失 / 解析失败 / 调用方显式要求纯文本） */
  fallback: boolean;
  /** 回落原因（可展示给用户） */
  reason?: 'css-missing' | 'render-error' | 'text-only';
}

const LATEX_HINT = '公式以源码显示（样式表未加载）';

/** 公式容器在页面里是否算得出高度：算不出就是 CSS 没加载 */
function probeCssMissing(doc: Document): boolean {
  const probe = doc.createElement('span');
  probe.className = 'katex';
  probe.textContent = 'x';
  probe.style.setProperty('position', 'absolute');
  probe.style.setProperty('visibility', 'hidden');
  doc.body.appendChild(probe);
  try {
    return probe.getBoundingClientRect().height === 0;
  } finally {
    probe.remove();
  }
}

let cssMissingCache: boolean | null = null;

/**
 * 当前文档是否缺 KaTeX 样式表（结果缓存，宿主注入 CSS 的时机早于任何渲染）。
 *
 * 为什么要缓存：每次渲染都插一个探针测高度，公式一多就是几十次强制重排。
 */
export function katexCssMissing(doc: Document): boolean {
  if (cssMissingCache === null) cssMissingCache = probeCssMissing(doc);
  return cssMissingCache;
}

/** 测试用：宿主可能在渲染中途才注入 CSS（dev 热更新 / 异步字体） */
export function resetKatexCssProbe(): void {
  cssMissingCache = null;
}

/** 源码回落形态：等宽 + 可选中复制，不是一坨红字 */
function sourceHtml(tex: string, reason: FormulaRender['reason']): string {
  const hint = reason === 'css-missing' ? LATEX_HINT : '公式渲染失败';
  return (
    `<code class="mdcore-formula-src" title="${hint}">${escapeHtml(tex)}</code>` +
    `<span class="mdcore-formula-note">${hint}</span>`
  );
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface RenderFormulaOptions {
  doc: Document;
  /** 调用方显式要求纯文本（平台适配器用：某些平台对公式支持很差） */
  textOnly?: boolean;
}

/**
 * 公式源码的数据属性名。
 *
 * 为什么要有这个显式契约：平台适配器（知乎/微信）需要把公式降级成 LaTeX 源码，
 * 早先它们靠 `.katex-display` / `.katex` 这两个 class 去认。但 CSS 缺失或渲染
 * 失败时我们走的是**源码回落形态**（没有那些 class），于是适配器认不出来，
 * 拿不到源码——公式在平台产物里成了空白。
 * class 是实现细节，属性才是契约。
 */
export const FORMULA_TEX_ATTR = 'data-mdcore-formula-tex';

/** 提取公式源码：先看显式属性（回落形态），再看 KaTeX 的 annotation / MathJax 的 alttext */
export function formulaTexOf(el: Element): string | null {
  const explicit = el.getAttribute(FORMULA_TEX_ATTR);
  if (explicit?.trim()) return explicit;
  const ann = el.querySelector('annotation[encoding="application/x-tex"]');
  if (ann?.textContent?.trim()) return ann.textContent;
  const alt = el.getAttribute('alttext'); // MathJax mjx-container 保留 alttext
  return alt?.trim() ? alt : null;
}

/**
 * TeX → HTML。
 *
 * `textOnly` 存在的意义不是"偷懒"，而是**承诺即兑现**：在拿不到 KaTeX 样式表的
 * 平台上（公众号编辑器的粘贴通道会丢 class 与外部字体），与其给一个塌掉的公式，
 * 不如给作者一段看得懂的源码 + 一句说明。
 */
export function renderFormula(tex: string, displayMode: boolean, opts: RenderFormulaOptions): FormulaRender {
  if (opts.textOnly) return { html: sourceHtml(tex, 'text-only'), fallback: true, reason: 'text-only' };
  if (katexCssMissing(opts.doc)) return { html: sourceHtml(tex, 'css-missing'), fallback: true, reason: 'css-missing' };
  try {
    const html = katex.renderToString(tex, {
      displayMode,
      throwOnError: true,
      output: 'html',
      // 微信清洗器对 MathML 一律降级，这里只出 HTML，避免产出两套树
      trust: false,
      strict: 'ignore',
    });
    return { html, fallback: false };
  } catch {
    // 失败原因不外泄到界面：作者要看到的是「公式渲染失败 + 他的源码」，
    // 而不是 KaTeX 抛出来的英文错误细节
    return { html: sourceHtml(tex, 'render-error'), fallback: true, reason: 'render-error' };
  }
}

/**
 * KaTeX 自带字体族：导出闸门要**显式 load**这些字族。
 *
 * 只等 `document.fonts.ready` 是不够的——`ready` 只保证"当下已知的字体加载完"，
 * 而 @font-face 是懒触发的：没用到某个字族时它根本不在队列里，ready 会先返回，
 * 截图就截到还没换上的 fallback 字体（Times/Computer Modern），字宽全错。
 */
export const KATEX_FONT_FAMILIES = [
  'KaTeX_Main',
  'KaTeX_Math',
  'KaTeX_Size1',
  'KaTeX_Size2',
  'KaTeX_Size3',
  'KaTeX_Size4',
  'KaTeX_AMS',
  'KaTeX_Caligraphic',
  'KaTeX_Typewriter',
  'KaTeX_SansSerif',
  'KaTeX_Script',
  'KaTeX_Fraktur',
] as const;

/** 等 KaTeX 字体就位（宿主/导出闸门调用；缺字体不抛错，只等到位） */
export async function waitForKatexFonts(doc: Document, timeoutMs = 2000): Promise<boolean> {
  const fonts = (doc as Document & { fonts?: FontFaceSet }).fonts;
  if (!fonts?.load) return false;
  const probe = doc.createElement('span');
  probe.className = 'katex';
  probe.textContent = '∑';
  probe.style.setProperty('position', 'absolute');
  probe.style.setProperty('visibility', 'hidden');
  doc.body.appendChild(probe);
  try {
    const loads = KATEX_FONT_FAMILIES.map((family) => fonts.load(`16px ${family}`));
    const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), timeoutMs));
    const result = await Promise.race([Promise.allSettled(loads).then(() => 'ok' as const), timeout]);
    return result === 'ok';
  } finally {
    probe.remove();
  }
}
