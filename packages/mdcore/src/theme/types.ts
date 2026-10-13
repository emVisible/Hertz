/**
 * 主题 token 体系（v0.36 重做：5 → 36）。
 *
 * 为什么要重做：v0.35 的 token 只有 `color/fontFamily/fontSize/lineHeight/radius`，
 * 于是「主题」退化成一张写死的样式字典——正文/次要/标题/引用四层墨色各写各的 hex、
 * 间距全是 px（字号一改比例就崩）、accent 实底上的文字色得手配（选错就是看不清）。
 * 参考仓库（WeMD 84 变量 / 小红书 26 变量）证明差距在**体系**不在主题数量。
 *
 * 三条约定：
 * 1. **主题只写差异项**。缺失的走 `TOKEN_DEFAULTS`，`resolveTokens()` 合成完整集。
 *    这样新增 token 时不必一次性改写 9 套内置主题，旧排版稿也不会因缺键而炸。
 * 2. **排版节奏用 em**（paraSpacing/sectionSpacing）。px 间距在 30px 的小红书卡片上
 *    和 16px 的微信正文上是两套比例；em 让"改字号"自动带着间距一起缩放。
 * 3. **样式开关也是 token**（headingStyle/quoteStyle/…）。它们不是 CSS 值而是渲染
 *    期分支（apply.ts 读它们决定挂什么结构），所以单列一组而不是塞进 styles。
 *
 * 兼容：`color/fontFamily/fontSize/lineHeight/radius` 五个旧键原样保留，
 * 存量排版稿的 overrides（正是写这五个键）继续生效，见 derive.test.ts 的迁移腿。
 */

/** CSS 属性表：kebab-case 属性 → 字面值（允许 `${token}` 引用 tokens） */
export type StyleProps = Record<string, string>;

/** 标题装饰样式（apply.ts 依此选结构，不是 CSS 值） */
export const HEADING_STYLES = [
  'none',
  'left-bar',
  'bottom-line',
  'boxed',
  'pill',
  'underline-highlight',
  'double-line',
  'section-number',
] as const;

/** 引用块样式 */
export const QUOTE_STYLES = ['left-bar', 'top-bottom', 'quote-mark', 'boxed', 'center-accent', 'corner-frame'] as const;

/** 加粗样式（含中文着重号 `text-emphasis: dot`） */
export const STRONG_STYLES = ['color', 'highlight', 'highlight-bottom', 'underline', 'dot'] as const;

/** 代码块头部样式 */
export const CODE_BARS = ['none', 'lang', 'mac'] as const;

/** 表格样式 */
export const TABLE_STYLES = ['plain', 'card'] as const;

/** 列表样式 */
export const LIST_STYLES = ['default', 'marker-color', 'cjk-numeral'] as const;

/** 分隔线样式 */
export const HR_STYLES = ['line', 'short', 'dashed', 'dots', 'pill'] as const;

export type HeadingStyle = (typeof HEADING_STYLES)[number];
export type QuoteStyle = (typeof QUOTE_STYLES)[number];
export type StrongStyle = (typeof STRONG_STYLES)[number];
export type CodeBar = (typeof CODE_BARS)[number];
export type TableStyle = (typeof TABLE_STYLES)[number];
export type ListStyle = (typeof LIST_STYLES)[number];
export type HrStyle = (typeof HR_STYLES)[number];

/**
 * 完整 token 集：渲染层（apply.ts / paginate / xhs）只认它。
 * 每一项都要么被主题显式声明，要么由 TOKEN_DEFAULTS 兜底——`resolveTokens()` 的
 * 存在就是为了保证**渲染时永远拿不到 undefined**。
 */
export interface ResolvedTokens {
  // 墨色五层：正文 / 次要 / 弱辅助 / 标题 / 引用
  ink: string;
  inkSoft: string;
  muted: string;
  headInk: string;
  quoteInk: string;

  // 主色族
  color: string;
  /** 主色底上的文字色（由 inkOn(color) 派生，见 derive 规则 2） */
  accentInk: string;
  /** 主色淡底（引用/表格/提示块的底） */
  soft: string;
  /** 描边/分隔线 */
  rule: string;
  /** 荧光笔底（`==高亮==`） */
  hl: string;
  /** 代码块底色与字色 */
  codeBg: string;
  codeInk: string;
  /** 画布底色（卡片/画布本身，xhs 卡片走它） */
  canvasBg: string;

  // 字体
  fontFamily: string;
  fontHead: string;
  fontMono: string;
  fontSize: string;
  lineHeight: string;
  letterSpacing: string;

  // 节奏（em 化）
  paraSpacing: string;
  sectionSpacing: string;
  /** 首行缩进：'0' 或 '2em' */
  indent: string;
  align: string;
  /** 行长上限（em），'none' = 不限 */
  measure: string;

  // 形状
  radius: string;
  imgRadius: string;
  border: string;
  shadow: string;

  // 样式开关（渲染期分支）
  headingStyle: HeadingStyle;
  quoteStyle: QuoteStyle;
  strongStyle: StrongStyle;
  codeBar: CodeBar;
  tableStyle: TableStyle;
  listStyle: ListStyle;
  hrStyle: HrStyle;
}

import { inkOn, withAlpha } from './color';

/** 主题声明用的 token 表：五键必填（每套主题都得有），其余按需。 */
export type ThemeTokens = Pick<ResolvedTokens, 'color' | 'fontFamily' | 'fontSize' | 'lineHeight' | 'radius'> &
  Partial<Omit<ResolvedTokens, 'color' | 'fontFamily' | 'fontSize' | 'lineHeight' | 'radius'>>;

/** 微调 overrides：随排版稿入库 = 「我的主题」。键集与 ThemeTokens 一致。 */
export type ThemeOverrides = Partial<ResolvedTokens>;

/**
 * 缺省 token：中性暖灰一版（近 WeMD basic 层）。
 * 选暖灰而不是纯黑白：纯黑字在纸感卡片上显脏，纯白底在暗色主题下又要反过来覆盖。
 */
export const TOKEN_DEFAULTS: ResolvedTokens = {
  ink: '#2b2b2b',
  inkSoft: '#5a5a5a',
  muted: '#8c8c8c',
  headInk: '#1f1f1f',
  quoteInk: '#4a4a4a',

  color: '#0f766e',
  accentInk: '#ffffff',
  soft: 'rgba(15, 118, 110, 0.08)',
  rule: 'rgba(15, 118, 110, 0.14)',
  hl: 'rgba(15, 118, 110, 0.26)',
  codeBg: '#f6f6f4',
  codeInk: '#2b2b2b',
  canvasBg: '#ffffff',

  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
  fontHead: '',
  fontMono: "'SFMono-Regular', Consolas, Menlo, 'Courier New', monospace",
  fontSize: '16px',
  lineHeight: '1.8',
  letterSpacing: '0.02em',

  paraSpacing: '1em',
  sectionSpacing: '1.75em',
  indent: '0',
  align: 'justify',
  measure: 'none',

  radius: '6px',
  imgRadius: '6px',
  border: '1px solid rgba(0, 0, 0, 0.08)',
  shadow: 'none',

  headingStyle: 'left-bar',
  quoteStyle: 'left-bar',
  strongStyle: 'color',
  codeBar: 'lang',
  tableStyle: 'card',
  listStyle: 'marker-color',
  hrStyle: 'short',
};

/** 字体栈兜底：标题没显式声明就与正文同族（省一套字体是有价值的默认）。 */
function withHeadFallback(tokens: ThemeTokens): ThemeTokens {
  return tokens.fontHead ? tokens : { ...tokens, fontHead: tokens.fontFamily };
}

/** 主题声明的 token（补齐标题字族兜底）——派生与渲染的共同入口。 */
export function declaredTokens(theme: Theme): ThemeTokens {
  return withHeadFallback(theme.tokens as ThemeTokens);
}

/**
 * 主题 + overrides + 缺省 → 完整 token 集（渲染层拿到的保证无 undefined）。
 *
 * 注意 `accentInk/soft/rule/hl` 这四行：它们**由主色算出**，不走缺省表。
 * 早先把这四个放在 TOKEN_DEFAULTS 里，于是 `overrides.color` 换成新主色之后
 * soft/rule/hl 还留在旧主色的档位上——颜色换了、配色族没换，是最难看出错的那种。
 * 现在唯一的例外是 overrides 显式给了它们（主题设计器可以手工指定）。
 */
export function resolveTokens(theme: Theme, overrides: ThemeOverrides = {}): ResolvedTokens {
  const merged: ResolvedTokens = {
    ...TOKEN_DEFAULTS,
    ...declaredTokens(theme),
    ...stripUndefined(overrides),
  };
  merged.accentInk = overrides.accentInk ?? inkOn(merged.color);
  merged.soft = overrides.soft ?? withAlpha(merged.color, 0.08);
  merged.rule = overrides.rule ?? withAlpha(merged.color, 0.14);
  merged.hl = overrides.hl ?? withAlpha(merged.color, 0.26);
  return merged;
}

function stripUndefined(values: ThemeOverrides): Partial<ResolvedTokens> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) {
    if (v !== undefined && v !== null && v !== '') out[k] = String(v);
  }
  return out as Partial<ResolvedTokens>;
}

export type ThemePlatform = 'wechat' | 'xhs' | 'zhihu' | 'generic';

export interface Theme {
  id: string;
  name: string;
  /** 平台调优（微信/小红书/知乎/generic） */
  platform: ThemePlatform;
  /** 深色款：预览深色开关优先切到同平台深色主题，而非滤镜近似 */
  dark?: boolean;
  tokens: ThemeTokens;
  /**
   * styles 键位（元素 → CSS）：
   * container / h1..h6 / headingContent / headingPrefix / headingSuffix /
   * para / link / strong / mark / em / inlineCode /
   * list / listItem / listMarker / pre / code / codeHead / codeLang /
   * table / th / td / quote / quoteL2 / quoteL3 / image / figcaption /
   * callout / callout-<variant> / formula / hr / card / cardBody / cardFooter /
   * hljs-*（代码高亮 token 色）
   */
  styles: Record<string, StyleProps>;
}