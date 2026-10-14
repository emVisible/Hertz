import type { StyleProps } from '../types';

/**
 * 主题结构基座（v0.36）。
 *
 * 为什么要有这一层：迁移前 9 套内置主题是 9 份几乎一样的骨架——同样 25 个键，
 * 大段相同的 font-size/margin/border-spacing，只在主色与三四个装饰上不同。
 * 那不是 9 套主题，是 1 套主题换了 9 个颜色。改一处间距要改 9 个文件，
 * 而"哪一处才是权威"这件事根本没人说得清。
 *
 * 现在分工明确：
 *   baseStyles()  = **结构**（字号阶梯、间距节奏、圆角、内边距、字族），一处作者；
 *   derivedSlots() = **装饰**（主色族、标题/引用/分隔线/表格的样式开关），一处作者；
 *   主题文件       = **性格**（token 值 + 少数几个槽位的偏离 + 代码高亮配色）。
 *
 * 主题不写装饰槽（h1..h6 / quote / strong / th / link / inlineCode / pre / hr /
 * mark / listMarker …），那些由 derivedSlots 统一产出——两边都写就是两个真相源。
 * 主题要偏离装饰时，改 token（headingStyle 等）而不是手写 CSS。
 */

/** 标题字号阶梯（em 相对正文，字号改一档整套跟着走） */
const HEADING_SCALE: Record<number, { size: string; weight: string }> = {
  1: { size: '1.7em', weight: '700' },
  2: { size: '1.4em', weight: '700' },
  3: { size: '1.18em', weight: '600' },
  4: { size: '1.05em', weight: '600' },
  5: { size: '1em', weight: '600' },
  6: { size: '0.94em', weight: '600' },
};

/** 代码高亮配色：浅色一套（GitHub Light 口径），深色主题换 `hljsDark` */
export const hljsLight: Record<string, StyleProps> = {
  'hljs-keyword': { color: '#cf222e' },
  'hljs-string': { color: '#0a3069' },
  'hljs-comment': { color: '#6e7781', 'font-style': 'italic' },
  'hljs-number': { color: '#0550ae' },
  'hljs-title': { color: '#8250df' },
  'hljs-attr': { color: '#953800' },
};

export const hljsDark: Record<string, StyleProps> = {
  'hljs-keyword': { color: '#ff7b72' },
  'hljs-string': { color: '#a5d6ff' },
  'hljs-comment': { color: '#8b949e', 'font-style': 'italic' },
  'hljs-number': { color: '#79c0ff' },
  'hljs-title': { color: '#d2a8ff' },
  'hljs-attr': { color: '#ffa657' },
};

export interface BaseOptions {
  /** 深色主题：代码高亮换深色配色、卡片底色更沉 */
  dark?: boolean;
  /** 小红书卡片向（1242px 画幅）：正文尺寸大、间距按 em 放大 */
  card?: boolean;
}

/**
 * 结构基座（不含任何主色装饰）。
 *
 * 刻意的取舍：
 * - 标题 margin-top 由 applyTheme 从 sectionSpacing token 下发，这里只管 margin-bottom；
 * - 段 margin-bottom 由 paraSpacing token 下发，这里不写——**两处都写就是两个真相源**；
 * - 颜色一律用 `${token}` 引用（ink / muted / codeBg…），主题换 token 即整套跟着换。
 */
export function baseStyles(opts: BaseOptions = {}): Record<string, StyleProps> {
  const { dark = false, card = false } = opts;
  const mono = '${fontMono}';
  const styles: Record<string, StyleProps> = {
    container: {
      'background-color': '${canvasBg}',
      padding: card ? '0' : '0 4px',
      'font-kerning': 'normal',
      // 中文缺字时允许合成粗斜体，避免 fallback 字体的 fake-bold 显脏
      'font-synthesis': 'weight style',
    },

    // 标题：字号阶梯 + 字族分离（宋体标题是观感差异最大的单一手段）
    headingContent: {},
    headingPrefix: {},

    para: {
      'font-family': '${fontFamily}',
      'text-wrap': 'pretty',
    },

    // 链接：颜色由派生给，这里给"不依赖 text-decoration 的下划线"（微信会吃掉部分装饰）
    link: {
      'text-decoration': 'none',
      'border-bottom': '1px solid ${rule}',
      'padding-bottom': '0.05em',
      'word-break': 'break-all',
    },
    strong: { 'font-weight': '700' },
    em: { 'font-style': 'italic' },
    inlineCode: {
      'font-family': mono,
      'font-size': '0.92em',
      'border-radius': '4px',
      padding: '0.1em 0.3em',
      'box-decoration-break': 'clone',
    },
    // mark（==高亮==）：底色与边距在派生槽，这里给字号与跨行不断
    mark: { padding: '0 0.1em', 'box-decoration-break': 'clone', 'border-radius': '2px' },
    sub: { 'font-size': '0.72em' },
    sup: { 'font-size': '0.72em' },
    ruby: { 'ruby-align': 'center' },
    rubyRt: { 'font-size': '0.5em', opacity: '0.75' },

    // 代码：卡片壳 + 头部 + 代码体
    codeCard: { 'background-color': '${codeBg}' },
    codeHead: {
      'font-size': '0.72em',
      'letter-spacing': '0.06em',
      'text-transform': 'uppercase',
      'font-family': '${fontFamily}',
      padding: '0.4em 0.8em',
    },
    codeLang: { 'font-weight': '600' },
    pre: {
      margin: '0',
      padding: '0.9em 1em',
      'overflow-x': 'auto',
      'background-color': 'transparent',
    },
    code: {
      'font-family': mono,
      'font-size': '0.86em',
      'line-height': '1.6',
      'background-color': 'transparent',
      color: '${codeInk}',
      // min-width: max-content 让 <pre> 自己产生横向滚动，而不是把卡片撑破
      'min-width': 'max-content',
      display: 'block',
      'white-space': 'pre',
      'text-align': 'left',
    },

    // 列表：序号与正文分离的排版基础（序号色由派生给）
    list: { 'margin-top': '0.4em', 'margin-bottom': '0.6em' },
    listItem: { 'margin-bottom': '0.35em' },
    listMarker: { 'margin-right': '0.45em', 'min-width': '1.2em', 'font-variant-numeric': 'tabular-nums' },

    // 表格：结构与内边距；表头底色/斑马纹由派生给
    table: {
      'border-collapse': 'separate',
      'border-spacing': '0',
      width: '100%',
      'font-size': '0.92em',
      'line-height': '1.5',
      'border-radius': '6px',
      overflow: 'hidden',
      'margin-top': '0.6em',
      'margin-bottom': '0.8em',
    },
    th: { 'font-weight': '600', padding: '0.5em 0.7em', 'text-align': 'left' },
    td: { padding: '0.5em 0.7em', 'border-top': '1px solid ${rule}', 'vertical-align': 'top' },
    tbodyEven: {},

    // 引用：字号与行距（边框与底色由派生给）
    quote: { 'font-size': '0.97em', 'line-height': '1.75' },
    quoteL2: {},
    quoteL3: {},
    quoteMark: {},

    // 图片与图注
    figure: { 'margin-top': '1.2em', 'margin-bottom': '1.2em' },
    image: { 'max-width': '100%', height: 'auto', display: 'block', 'border-radius': '${imgRadius}', margin: '0 auto' },
    figcaption: { color: '${muted}', 'margin-top': '0.5em' },

    // 提示块
    callout: { padding: '0.7em 0.9em', 'border-radius': '6px', 'font-size': '0.97em', 'margin-top': '0.6em', 'margin-bottom': '0.6em' },
    formula: { 'margin-top': '0.8em', 'margin-bottom': '0.8em', 'text-align': 'center', 'overflow-x': 'auto' },

    hr: {},

    // 定义列表 / 脚注（结构件，槽位与目录同族）
    deflist: { margin: '0.6em 0' },
    defTerm: { 'font-weight': '600', 'margin-top': '0.6em' },
    defDef: { 'margin-left': '1.4em', color: 'inherit' },
    footnoteArea: { 'margin-top': '1.6em', 'padding-top': '0.8em' },
    footnoteItem: { 'font-size': '0.86em', 'line-height': '1.7', margin: '0 0 0.3em' },
    footnoteNum: { color: 'inherit' },
    footnoteRef: { 'font-size': '0.7em', 'vertical-align': 'super', 'line-height': '0' },

    // 目录（颜色/底色由 derivedSlots 统一派生，base 只给中性骨架）
    toc: { 'margin-top': '0.5em', 'margin-bottom': '1em', padding: '0.6em 0.8em' },
    tocItem: { 'font-size': '0.92em', 'line-height': '1.9', margin: '0' },
    tocLink: { 'text-decoration': 'none', 'border-bottom': 'none', color: 'inherit' },
    tocEmpty: { 'font-size': '0.85em', opacity: '0.7' },
    // #话题
    tag: { color: 'inherit', 'font-weight': '600' },

    // 小红书卡片位（微信/知乎主题不填页壳样式时这两个键不会被用到）
    card: { 'background-color': '${canvasBg}', 'border-radius': '${radius}' },
    cardBody: {},
    cardFooter: { 'font-size': '0.8em', 'line-height': '1.4' },

    ...(dark ? hljsDark : hljsLight),
  };

  for (const [level, { size, weight }] of Object.entries(HEADING_SCALE)) {
    styles[`h${level}`] = {
      'font-size': size,
      'font-weight': weight,
      'font-family': '${fontHead}',
      color: 'inherit',
      'line-height': '1.4',
      'margin-bottom': '0.45em',
      'letter-spacing': level === '1' ? '-0.01em' : '0',
      // 标题防孤字（text-wrap: balance 是标题观感最省事的一处提升）
      'text-wrap': 'balance',
    };
  }
  return styles;
}

/** 标题前距：标题上方留白比段距大一档（结构的一部分，主题不各写一份） */
export const SECTION_MARGIN = '1.15em';