/**
 * 主题导出为独立 CSS（P2-5 之外的 P2-2 / v0.37）。
 *
 * ## 这份 CSS 是给谁的
 *
 * 不是给本工具的渲染器用的（渲染器吃的是 `applyTheme()` 的内联样式），而是给
 * **别人**：拿到我们主题 JSON 的人，想在自己的 Markdown 预览器 / 静态站点里
 * 复现同一套排版。mdnice 的 `themeExporter` 是同一个定位。
 *
 * ## 唯一真相源的问题：slot → selector 映射
 *
 * 内联渲染时"哪个槽写到哪个元素"由 `apply.ts` 的 switch 决定，没有声明式表格；
 * 而 CSS 必须有选择器。于是这里有一份**映射表**，它与 `apply.ts` 是两份真相源——
 * 漂移的后果是"导出的 CSS 少了几处排版"，而且**两边测试都不会红**。
 *
 * 所以判据必须是**可证的**：把一份厨房水槽稿分别渲染成
 *   ① 内联样式树（applyTheme 的产物）
 *   ② 剥光 inline style + 注入本文产出的 CSS 的树
 * 然后逐元素逐属性比 `getComputedStyle`。映射表少一处、错一处，那条断言就红。
 * 见 `theme/css.test.ts` 的「导出 CSS 在纯净页面复现主题」。
 *
 * 因此这份表要**跟着 apply.ts 改**，而测试会立刻告诉你哪条漏了。
 */
import { resolveThemeSlots } from './derive';
import { getTheme } from './index';
import { CALLOUT_VARIANTS } from '../parse/markdown';
import type { StyleProps, Theme, ThemeOverrides } from './types';

/**
 * slot → CSS 选择器。
 *
 * 形状与 `apply.ts` 的渲染分支一一对应。规则：
 * - 一律带 `.mdcore-doc` 前缀：不污染宿主页面（分享形态最容易被直接贴进去）；
 * - hljs-* 与 `hljs-meta .hljs-keyword` 这类**本身就是选择器**，不在表里；
 * - `container` 特殊：它同时带 token 直下的 font/color/background（见 emit）。
 */
const SLOT_SELECTORS: Record<string, string> = {
  container: '.mdcore-doc',

  h1: '.mdcore-doc > h1',
  h2: '.mdcore-doc > h2',
  h3: '.mdcore-doc > h3',
  h4: '.mdcore-doc > h4',
  h5: '.mdcore-doc > h5',
  h6: '.mdcore-doc > h6',
  headingPrefix: '.mdcore-doc .mdcore-h-prefix',
  headingContent: '.mdcore-doc .mdcore-h-content',

  para: '.mdcore-doc p',

  link: '.mdcore-doc a',
  strong: '.mdcore-doc strong',
  em: '.mdcore-doc em',
  mark: '.mdcore-doc mark',
  sub: '.mdcore-doc sub',
  sup: '.mdcore-doc sup',
  ruby: '.mdcore-doc ruby',
  rubyRt: '.mdcore-doc rt',
  ins: '.mdcore-doc ins',
  tag: '.mdcore-doc .mdcore-tag',
  coloredText: '.mdcore-doc .mdcore-colored, .mdcore-doc span.mdcore-colored',
  br: '.mdcore-doc br',

  list: '.mdcore-doc ul, .mdcore-doc ol',
  listItem: '.mdcore-doc li',
  listMarker: '.mdcore-doc .mdcore-marker',
  liContent: '.mdcore-doc .mdcore-li-content',

  inlineCode: '.mdcore-doc code',
  codeCard: '.mdcore-doc .mdcore-code',
  codeHead: '.mdcore-doc .mdcore-code-head',
  codeLang: '.mdcore-doc .mdcore-code-lang',
  codeDots: '.mdcore-doc .mdcore-code-dots',
  codeDot: '.mdcore-doc .mdcore-code-dot',
  pre: '.mdcore-doc .mdcore-code pre',
  code: '.mdcore-doc .mdcore-code pre code',

  tableWrap: '.mdcore-doc .mdcore-table-wrap',
  table: '.mdcore-doc .mdcore-table',
  // tableCell 的属性 apply.ts 是**逐格写**的（th/td 各写一遍），所以 CSS 里
  // 也得两处都带——只挂 th 会让单元格的换行规则整个丢失
  tableCell: '.mdcore-doc .mdcore-table th, .mdcore-doc .mdcore-table td',
  th: '.mdcore-doc .mdcore-table th',
  td: '.mdcore-doc .mdcore-table td',
  thFirst: '.mdcore-doc .mdcore-table th.mdcore-th-first',
  thLast: '.mdcore-doc .mdcore-table th.mdcore-th-last',
  tbodyEven: '.mdcore-doc .mdcore-table .mdcore-row-even',

  quote: '.mdcore-doc blockquote',
  quoteL2: '.mdcore-doc blockquote.mdcore-quote-l2',
  quoteL3: '.mdcore-doc blockquote.mdcore-quote-l3',
  quoteMark: '.mdcore-doc .mdcore-quote-mark',

  figure: '.mdcore-doc figure',
  image: '.mdcore-doc figure.mdcore-figure img',
  figcaption: '.mdcore-doc figcaption',

  callout: '.mdcore-doc .mdcore-callout',
  formula: '.mdcore-doc .mdcore-formula',
  formulaInline: '.mdcore-doc .mdcore-formula-inline',
  formulaSrc: '.mdcore-doc .mdcore-formula-src',
  formulaNote: '.mdcore-doc .mdcore-formula-note',

  hr: '.mdcore-doc hr, .mdcore-doc .mdcore-hr-dots',

  deflist: '.mdcore-doc dl.mdcore-deflist',
  defTerm: '.mdcore-doc dt.mdcore-def-term',
  defDef: '.mdcore-doc dd.mdcore-def-def',

  footnoteArea: '.mdcore-doc .mdcore-footnotes',
  footnoteItem: '.mdcore-doc .mdcore-footnote-item',
  footnoteNum: '.mdcore-doc .mdcore-footnote-num',
  // apply.ts 把 footnoteRef 同时写给 <sup> 与它内部的 <a>；只挂 sup 的话
  // 角标里的数字会退回链接色（.mdcore-doc a 那条规则照样命中它）
  footnoteRef: '.mdcore-doc .mdcore-footnote-ref, .mdcore-doc .mdcore-footnote-ref a',

  toc: '.mdcore-doc .mdcore-toc',
  tocItem: '.mdcore-doc .mdcore-toc-item',
  tocLink: '.mdcore-doc .mdcore-toc-link',
  tocEmpty: '.mdcore-doc .mdcore-toc-empty',

  imageInline: '.mdcore-doc p img, .mdcore-doc li img, .mdcore-doc td img, .mdcore-doc th img, .mdcore-doc blockquote img',
};

/** 卡片/页壳类槽：微信/知乎长文里不出现，但分享形态会带上（小红书稿很常见） */
const CARD_SLOT_SELECTORS: Record<string, string> = {
  card: '.mdcore-card',
  cardBody: '.mdcore-card-body',
  cardHeader: '.mdcore-card-header',
  cardFooter: '.mdcore-card-footer',
  coverBadge: '.mdcore-cover-badge',
  coverTitle: '.mdcore-cover-title',
  coverSub: '.mdcore-cover-sub',
};

function rule(selector: string, props: StyleProps): string {
  const body = Object.entries(props)
    .map(([prop, value]) => `  ${prop}: ${value};`)
    .join('\n');
  return `${selector} {\n${body}\n}`;
}

export interface ThemeCssOptions {
  /** 附加注释（写进文件头，例如主题名与生成时间） */
  header?: string;
}

/**
 * 主题（含 overrides）→ 独立 CSS 文本。
 *
 * 输出的 class 名就是渲染态 DOM 上那些 `mdcore-*`，所以把 CSS 与
 * `applyTheme()` 的结构一起贴进任意页面即可复现主题排版。
 */
export function themeToCss(
  theme: Theme | string,
  overrides: ThemeOverrides = {},
  opts: ThemeCssOptions = {},
): string {
  const resolved = typeof theme === 'string' ? getTheme(theme) : theme;
  const { tokens, styles } = resolveThemeSlots(resolved, overrides);

  const out: string[] = [];
  out.push('/*');
  out.push(` * MD Studio 主题导出 · ${resolved.name}（${resolved.id}）`);
  if (opts.header) out.push(` * ${opts.header}`);
  out.push(' *');
  out.push(' * 用法：把本文件与 applyTheme() 的结构（class 名以 mdcore- 开头）一起贴进页面。');
  out.push(' *');
  out.push(' * 本文件由 mdcore 的 theme/css.ts 生成，与内联渲染共用 resolveThemeSlots()，');
  out.push(' * 因此与工坊里的所见一致；判据见 theme/css.test.ts 的「导出 CSS 在纯净页面复现主题」。');
  out.push(' */');
  out.push('');

  // 容器：槽样式 + applyTheme 直写的 token 属性
  const containerProps: StyleProps = {
    ...styles.container,
    'font-family': tokens.fontFamily,
    'font-size': tokens.fontSize,
    'line-height': tokens.lineHeight,
    'letter-spacing': tokens.letterSpacing,
    color: tokens.ink,
    'line-break': 'strict',
    'word-break': 'break-word',
    'overflow-wrap': 'break-word',
  };
  if (!containerProps['background-color']) containerProps['background-color'] = tokens.canvasBg;
  out.push(rule(SLOT_SELECTORS.container, containerProps));

  // 正文块上由 token 直写的三处（apply.ts 的 para / heading / toc 分支）
  out.push(rule('.mdcore-doc p', { 'margin-bottom': tokens.paraSpacing }));
  out.push(
    rule('.mdcore-doc p', {
      ...(tokens.indent !== '0' ? { 'text-indent': tokens.indent } : {}),
      ...(tokens.measure !== 'none' ? { 'max-width': tokens.measure } : {}),
      ...(tokens.align === 'justify'
        ? { 'text-align': 'justify', 'text-justify': 'inter-ideograph' }
        : {}),
    }),
  );
  for (let level = 1; level <= 6; level += 1) {
    out.push(rule(`.mdcore-doc > h${level}`, { 'margin-top': tokens.sectionSpacing }));
  }

  /**
   * 列表：自绘序号 → 关掉浏览器 marker，缩进走 paraSpacing。
   * apply.ts 在 list 分支里逐条直写这两行，槽位表只管 list 槽本身。
   */
  out.push(
    rule('.mdcore-doc ul, .mdcore-doc ol', {
      'list-style': 'none',
      'padding-left': tokens.paraSpacing,
    }),
  );

  // 目录三级缩进（apply.ts 按 block.level 直写 padding-left）
  out.push(rule('.mdcore-doc .mdcore-toc-item.mdcore-toc-l3', { 'padding-left': '1.2em' }));

  // 提示块的变体槽：note/tip/warning/danger/info/callout 各带自己的底色与字色
  for (const variant of CALLOUT_VARIANTS) {
    const props = styles[`callout-${variant}`];
    if (!props || !Object.keys(props).length) continue;
    out.push(rule(`.mdcore-doc .mdcore-callout-${variant}`, props));
  }

  // 槽 → 选择器
  const emitted = new Set<string>();
  for (const [slot, selector] of Object.entries({ ...SLOT_SELECTORS, ...CARD_SLOT_SELECTORS })) {
    if (slot === 'container') continue; // 已单独合并
    const props = styles[slot];
    if (!props || !Object.keys(props).length) continue;
    if (emitted.has(slot)) continue;
    emitted.add(slot);
    out.push(rule(selector, props));
  }

  // hljs-*：键名本身就是选择器（含后代选择器），不在映射表里
  for (const key of Object.keys(styles).sort()) {
    if (!/^hljs/.test(key)) continue;
    const props = styles[key];
    if (!props || !Object.keys(props).length) continue;
    out.push(rule(`.mdcore-doc .${key}`, props));
  }

  /**
   * 脚注角标的 `<a>`：它是一个锚点，但**不是正文链接**。
   *
   * 内联渲染里它只带 footnoteRef 的属性（没有 link 槽的 border-bottom/下划线），
   * 而样式表里 `.mdcore-doc a` 那条规则照样命中它——不显式归零就会比内联多一道下划线。
   *
   * 为什么排在最后：真浏览器按**特异性**算（这条 0-3-1 稳压 0-2-1），顺序无所谓；
   * 但 jsdom 的层叠只认**先后**（顺序即优先级），排在后面才对两种环境都成立。
   * 判据跑在 jsdom 上——写成"浏览器里对、判据里红"是最坏的一种不一致。
   */
  out.push(
    rule('.mdcore-doc .mdcore-footnote-ref a', {
      'border-bottom': 'none',
      'text-decoration': 'none',
      'padding-bottom': '0',
      'word-break': 'normal',
    }),
  );

  return `${out.join('\n')}\n`;
}