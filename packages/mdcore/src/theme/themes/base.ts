import type { StyleProps, ThemeTokens } from '../types';

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

/**
 * 代码高亮配色：浅色一套（GitHub Light 口径），深色主题换 `hljsDark`。
 *
 * 此前只有 6 个类，而 hljs 实产 40+ 类——`built_in`、`literal`、`type`、
 * `variable`、`property`、`meta`、`selector`…全部落到无色默认继承。于是
 * Python 的 `print`、SQL 的 `SELECT`、Go 的 `int` 在成品里和普通文字一模一样。
 *
 * 覆盖的是"读者真的会分辨"的类目，不是 hljs 的全集：把 40+ 个类都调一遍，
 * 一半会撞色，一半会让配色变成一锅粥。判据守的是"每个语言的关键类目有颜色"。
 */
export const hljsLight: Record<string, StyleProps> = {
  // 关键字族
  'hljs-keyword': { color: '#cf222e' },
  'hljs-built_in': { color: '#8250df' },
  'hljs-type': { color: '#953800' },
  'hljs-literal': { color: '#0550ae' },
  'hljs-meta': { color: '#6639ba' },
  'hljs-meta .hljs-keyword': { color: '#cf222e' },
  'hljs-meta .hljs-string': { color: '#0a3069' },
  // 字面量
  'hljs-string': { color: '#0a3069' },
  'hljs-regexp': { color: '#0a3069' },
  'hljs-char.escape': { color: '#116329' },
  'hljs-number': { color: '#0550ae' },
  'hljs-symbol': { color: '#0969da' },
  // 名字族
  'hljs-title': { color: '#8250df' },
  'hljs-title.class': { color: '#953800' },
  'hljs-title.class.inherited': { color: '#953800' },
  'hljs-title.function': { color: '#8250df' },
  'hljs-params': { color: '#24292f' },
  'hljs-variable': { color: '#24292f' },
  'hljs-variable.language': { color: '#cf222e' },
  'hljs-variable.constant': { color: '#0550ae' },
  'hljs-property': { color: '#0550ae' },
  'hljs-attr': { color: '#953800' },
  'hljs-attribute': { color: '#953800' },
  'hljs-selector-tag': { color: '#116329' },
  'hljs-selector-class': { color: '#953800' },
  'hljs-selector-id': { color: '#0550ae' },
  'hljs-name': { color: '#116329' },
  'hljs-tag': { color: '#24292f' },
  'hljs-doctag': { color: '#6e7781' },
  // 注释
  'hljs-comment': { color: '#6e7781', 'font-style': 'italic' },
  'hljs-quote': { color: '#6e7781', 'font-style': 'italic' },
  // 其它
  'hljs-operator': { color: '#cf222e' },
  'hljs-punctuation': { color: '#24292f' },
  'hljs-deletion': { color: '#82071e', 'background-color': '#ffebe9' },
  'hljs-addition': { color: '#116329', 'background-color': '#dafbe1' },
  'hljs-emphasis': { 'font-style': 'italic' },
  'hljs-strong': { 'font-weight': '600' },
};

export const hljsDark: Record<string, StyleProps> = {
  'hljs-keyword': { color: '#ff7b72' },
  'hljs-built_in': { color: '#d2a8ff' },
  'hljs-type': { color: '#ffa657' },
  'hljs-literal': { color: '#79c0ff' },
  'hljs-meta': { color: '#d2a8ff' },
  'hljs-meta .hljs-keyword': { color: '#ff7b72' },
  'hljs-meta .hljs-string': { color: '#a5d6ff' },
  'hljs-string': { color: '#a5d6ff' },
  'hljs-regexp': { color: '#a5d6ff' },
  'hljs-char.escape': { color: '#7ee787' },
  'hljs-number': { color: '#79c0ff' },
  'hljs-symbol': { color: '#79c0ff' },
  'hljs-title': { color: '#d2a8ff' },
  'hljs-title.class': { color: '#ffa657' },
  'hljs-title.class.inherited': { color: '#ffa657' },
  'hljs-title.function': { color: '#d2a8ff' },
  'hljs-params': { color: '#c9d1d9' },
  'hljs-variable': { color: '#c9d1d9' },
  'hljs-variable.language': { color: '#ff7b72' },
  'hljs-variable.constant': { color: '#79c0ff' },
  'hljs-property': { color: '#79c0ff' },
  'hljs-attr': { color: '#ffa657' },
  'hljs-attribute': { color: '#ffa657' },
  'hljs-selector-tag': { color: '#7ee787' },
  'hljs-selector-class': { color: '#ffa657' },
  'hljs-selector-id': { color: '#79c0ff' },
  'hljs-name': { color: '#7ee787' },
  'hljs-tag': { color: '#c9d1d9' },
  'hljs-doctag': { color: '#8b949e' },
  'hljs-comment': { color: '#8b949e', 'font-style': 'italic' },
  'hljs-quote': { color: '#8b949e', 'font-style': 'italic' },
  'hljs-operator': { color: '#ff7b72' },
  'hljs-punctuation': { color: '#c9d1d9' },
  'hljs-deletion': { color: '#ffdcd7', 'background-color': '#67060c' },
  'hljs-addition': { color: '#aff5b4', 'background-color': '#033a16' },
  'hljs-emphasis': { 'font-style': 'italic' },
  'hljs-strong': { 'font-weight': '600' },
};

export interface BaseOptions {
  /** 深色主题：代码高亮换深色配色、卡片底色更沉 */
  dark?: boolean;
  /** 小红书卡片向（1242px 画幅）：正文尺寸大、间距按 em 放大 */
  card?: boolean;
  /**
   * 排版深度（W3）：组件级尺寸与标题阶跃。
   *
   * 可选是有意的：**基座不依赖 token 层**，所以它也能被单独调用（老测试与
   * 主题定义里直接用 `baseStyles()`）。没给时回落到原先写死的那些值——
   * 「加旋钮不许顺手改掉既有版式」这条规矩，靠的就是这个回落。
   */
  depth?: Partial<
    Pick<
      ThemeTokens,
      | 'headingStep'
      | 'captionSize'
      | 'quoteSize'
      | 'codeSize'
      | 'tableSize'
      | 'listSpacing'
      | 'codeLineHeight'
      | 'tableCellPad'
    >
  >;
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
  // 回落值 = 原先写死的那几个数（见 BaseOptions.depth 的说明）
  const depth = {
    headingStep: '1.18',
    captionSize: '0.82em',
    quoteSize: '0.97em',
    codeSize: '0.86em',
    tableSize: '0.92em',
    listSpacing: '0.35em',
    codeLineHeight: '1.6',
    tableCellPad: '0.5em 0.7em',
    ...opts.depth,
  };
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
    // Mac 三色点：此前只设了 background-color，**没有任何尺寸**——空 span 是 0×0，
    // 真浏览器里三点完全不可见，而当时的测试只断言背景色，把这个缺陷钉成了"正确"。
    codeDots: { display: 'inline-flex', gap: '0.35em', 'align-items': 'center', 'margin-right': '0.6em' },
    codeDot: { width: '0.62em', height: '0.62em', 'border-radius': '50%', display: 'inline-block' },
    pre: {
      margin: '0',
      padding: '0.9em 1em',
      'overflow-x': 'auto',
      'background-color': 'transparent',

    },
    code: {
      'font-family': mono,
      /**
       * 字号与行距**都挂在 `code` 槽**，而且只此一处。
       *
       * `code` 槽是**行内代码与块级代码共用**的（块级是 `<pre><code>`），
       * 所以：挂 `pre` 上 → 行内代码失去缩小（实测长文页面高了 8px，基线图抓到）；
       * 两处都挂 → 变成 0.86 × 0.86 的双重缩小（页面矮 20px）。**只能挂一处，挂 code。**
       */
      'font-size': depth.codeSize,
      'line-height': depth.codeLineHeight,
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
    // 列表项内容：缩进/对齐/断词都在这里可调（此前完全没有槽）
    liContent: { 'word-break': 'break-word', 'overflow-wrap': 'anywhere' },
    // 硬换行：微信清洗器不认 <br> 之外的任何写法，尺寸必须可调
    br: {},
    // `[color:#xxx]` 彩色文字
    coloredText: {},
    listItem: { 'margin-bottom': depth.listSpacing },
    listMarker: { 'margin-right': '0.45em', 'min-width': '1.2em', 'font-variant-numeric': 'tabular-nums' },

    // 表格：结构与内边距；表头底色/斑马纹由派生给
    // 窄表横滚容器：块级元素是它（见 apply 的 table 分支）
    tableWrap: { 'max-width': '100%', 'overflow-x': 'auto', '-webkit-overflow-scrolling': 'touch' },
    // 表格本体：圆角/overflow 放在 display:table 上是**无效**的（不产生 BFC），
    // 裁切交给外层 .mdcore-table-wrap；表头的圆角在 derive 里按首末格单独写。
    table: {
      'border-collapse': 'separate',
      'border-spacing': '0',
      width: '100%',
      'font-size': depth.tableSize,
      'line-height': '1.5',
      'border-radius': '6px',
      overflow: 'hidden',
      'margin-top': '0.6em',
      'margin-bottom': '0.8em',
    },
    // 单元格：长 URL / 长 ID 逐字折行会把整张表撑成筛子
    tableCell: { 'word-break': 'break-word', 'overflow-wrap': 'anywhere' },
    // 表头首/末格的圆角（逐格写死，见 apply 的说明）
    thFirst: { 'border-top-left-radius': '6px', 'border-bottom-left-radius': '6px' },
    thLast: { 'border-top-right-radius': '6px', 'border-bottom-right-radius': '6px' },
    th: { 'font-weight': '600', padding: depth.tableCellPad, 'text-align': 'left' },
    td: { padding: depth.tableCellPad, 'border-top': '1px solid ${rule}', 'vertical-align': 'top' },
    tbodyEven: {},

    // 引用：字号与行距（边框与底色由派生给）
    quote: { 'font-size': depth.quoteSize, 'line-height': '1.75' },
    quoteL2: {},
    quoteL3: {},
    quoteMark: {},

    // 图片与图注
    image: { 'max-width': '100%', height: 'auto', display: 'block', 'border-radius': '${imgRadius}', margin: '0 auto' },
    // 行内图：**不能**继承块级槽的 display:block（会撑断图文流）
    imageInline: {
      'max-width': '100%',
      height: 'auto',
      display: 'inline-block',
      'vertical-align': 'middle',
      'border-radius': '${imgRadius}',
    },
    figcaption: { 'font-size': '0.82em', 'line-height': '1.6', 'margin-top': '0.5em' },

    // 提示块
    callout: { padding: '0.7em 0.9em', 'border-radius': '6px', 'font-size': '0.97em', 'margin-top': '0.6em', 'margin-bottom': '0.6em' },
    // 公式：显示公式用容器槽，行内公式用自己的槽（此前是「裸 span 零样式」）
    formula: {
      'margin-top': '0.9em',
      'margin-bottom': '0.9em',
      'text-align': 'center',
      // overflow-x 对 .katex-display 无效（子树会撑开而不是滚动），
      // 超宽公式交给 KaTeX 自己的缩放，这里只兜住极端情况
      'max-width': '100%',
      overflow: 'hidden',
    },
    formulaInline: { 'font-size': '1em', 'line-height': '1', 'vertical-align': 'baseline' },
    // 公式回落：源码 + 提示（KaTeX CSS 缺失或渲染失败时用）
    formulaSrc: {
      'font-family': 'var(--hz-mono, monospace)',
      'font-size': '0.88em',
      padding: '0.1em 0.3em',
      'border-radius': '3px',
      'background-color': 'inherit',
    },
    formulaNote: { 'font-size': '0.78em', 'margin-left': '0.4em', opacity: '0.7' },

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
    tocItem: { 'font-size': '0.92em' },
    tocLink: { 'text-decoration': 'none', 'border-bottom': 'none', color: 'inherit' },
    tocEmpty: { 'font-size': '0.85em', opacity: '0.7' },
    // #话题
    tag: { color: 'inherit', 'font-weight': '600' },

    // 小红书卡片位（微信/知乎主题不填页壳样式时这两个键不会被用到）
    card: { 'background-color': '${canvasBg}', 'border-radius': '${radius}' },
    cardBody: {},
    // 封面三件套：角标（药丸）/ 标题（自适应字号）/ 副标题（弱一档）
    coverBadge: {
      'align-self': 'flex-start',
      padding: '0.24em 0.9em',
      'border-radius': '999px',
      'font-size': '0.34em',
      'font-weight': '600',
      'letter-spacing': '0.06em',
    },
    coverTitle: { margin: '0.12em 0', 'font-weight': '700', 'line-height': '1.22', 'letter-spacing': '0em' },
    coverSub: { 'font-size': '0.62em', 'line-height': '1.5', margin: '0.2em 0 0' },
    cardHeader: { 'font-size': '0.72em', 'line-height': '1.4', opacity: '0.62', 'margin-bottom': '1.2em' },
    // 块级描边槽：给需要描边的块用（此前各处手写字面量，改 token 毫无反应）
    blockBorder: {},
    // 页脚是左右分布的（署名靠左、页码靠右）。页壳层化的改动把旧实现里内联的
    // display:flex / space-between 弄丢了，于是两段文字贴在了一起——基线图一眼看出来
    cardFooter: {
      display: 'flex',
      'justify-content': 'space-between',
      'align-items': 'baseline',
      gap: '1em',
      'font-size': '0.8em',
      'line-height': '1.4',
    },

    ...(dark ? hljsDark : hljsLight),
  };

  for (const [level, { size, weight }] of Object.entries(HEADING_SCALE)) {
    styles[`h${level}`] = {
      'font-size': size,
      'font-weight': weight,
      'font-family': '${fontHead}',
      // 字色由 derive 接到 `headInk`（见 derive 头注第 6 条）。这里曾写死
      // `color: 'inherit'`，于是标题恒与正文同色——设计器里那个「标题」色槽成了摆设。
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