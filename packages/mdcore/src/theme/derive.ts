import {
  declaredTokens,
  resolveTokens,
  type ResolvedTokens,
  type StyleProps,
  type Theme,
  type ThemeOverrides,
  type ThemeTokens,
} from './types';
import { deepen, isHexColor, withAlpha } from './color';
import { getTheme } from './index';

/**
 * 色盘一键换色与装饰派生（§4，doocs/md 式）。
 *
 * v0.36 的结构决定：**所有依赖 token 的样式槽都在这里派生，只有一处作者**。
 *
 * v0.35 的做法是「改了主色才跑一遍 deriveTheme」，于是槽位（mark / listMarker /
 * codeHead / tbodyEven …）在**不换色时根本不存在**——主题里没写就没有，
 * `applyTheme` 拿不到它们，斑马纹、序号配色、代码头部全部静默消失。
 * 现在的形态是：先合成最终 token（主题 + overrides + 缺省），再由
 * `derivedSlots(tokens)` 产出**补丁表**，逐键叠在主题自带 styles 之上。
 * 于是「换色」不再是特判路径，它只是 overrides 里多了一个 `color` 而已。
 *
 * 派生规则（与 `derive.test.ts` 头注一一对应，改规则必须同步改测试）：
 *   1. accentInk = inkOn(color) —— 主色底上的文字按 WCAG 对比度二选一
 *   2. soft / rule / hl = 主色的 8% / 14% / 26%
 *   3. link 字色 = 主色压暗 10%
 *   4. strong 按 strongStyle：color 用主色 / highlight 用 hl 底 /
 *      highlight-bottom 渐变涂抹 / underline 下划线 / dot 中文着重号
 *   5. 标题按 headingStyle（8 种），装饰分「撑满整行挂 h*」与「贴着文字挂内容 span」
 *   6. 标题字色默认 headInk（不是主色）——主色留给装饰，层级才不糊成一片
 *   7. 引用按 quoteStyle（6 种）；quote-mark 的大引号是物化节点，配 quoteMark 槽
 *   8. 提示块 5 变体：note 蓝 / tip 绿 / warning 琥珀 / danger 红 / info 跟主色
 *   9. 行内代码字色压暗 10% + 底 12%；mark 用 hl 底
 *  10. 代码卡片壳边框 24%（pre 不再画边框）；头部文字 55%
 *  11. 表格 card 模式表头主色实底 + accentInk 字、隔行 soft 底
 *  12. 列表序号跟主色（正文跟墨色）
 *  13. 分隔线按 hrStyle（5 种）；三圆点的点颜色在 hrDot 槽
 *  14. cardFooter（xhs 品牌页脚）字色 = 主色 55%
 *
 * 纯函数：不改动基题（styles 逐键浅拷贝）。
 */

/** 装饰重置集：每种样式先清零再上自己的装饰。 */
const DECOR_RESET = {
  'border-left': 'none',
  'border-right': 'none',
  'border-top': 'none',
  'border-bottom': 'none',
  'border-radius': '0',
  'background-color': 'transparent',
  'background-image': 'none',
  display: 'block',
  padding: '0',
} as const;

/**
 * 依赖 token 的样式补丁表。键是样式槽，值是**叠加在主题自带样式之上**的补丁——
 * 主题自己的字号/行距不会被这里覆盖（派生只管"主色族与装饰"）。
 */
export function derivedSlots(t: ResolvedTokens): Record<string, StyleProps> {
  const primary = t.color;
  const accentInk = t.accentInk;
  const soft = t.soft;
  const rule = t.rule;
  const hl = t.hl;
  const linkInk = deepen(primary, 10);
  const heading = headingPaint(t.headingStyle, primary, rule, soft, accentInk);
  const quote = quotePaint(t.quoteStyle, primary, rule, soft);

  const slots: Record<string, StyleProps> = {
    // 规则 3、9：行内件
    link: { color: linkInk },
    inlineCode: { color: linkInk, 'background-color': withAlpha(primary, 0.12) },
    mark: { 'background-color': hl, color: 'inherit' },
    strong: strongPaint(t.strongStyle, primary, hl),

    // 规则 5、6：标题
    headingContent: heading.content,
    headingPrefix: heading.prefix,
    ...Object.fromEntries([1, 2, 3, 4, 5, 6].map((l) => [`h${l}`, heading.block])),

    // 规则 7：引用三层级 + 大引号
    quote,
    quoteL2: quotePaint('left-bar', primary, rule, soft),
    quoteL3: quotePaint('left-bar', primary, rule, soft),
    quoteMark: {
      color: withAlpha(primary, 0.5),
      'font-size': '2.4em',
      'line-height': '1',
      display: 'inline-block',
      'margin-right': '0.12em',
      'font-family': 'Georgia, "Times New Roman", serif',
    },

    // 规则 8：提示块 5 变体（note/tip/warning/danger/info + callout 别名）
    callout: { 'border-left': `3px solid ${primary}` },
    'callout-note': variantPaint('#2563eb'),
    'callout-tip': variantPaint('#0f766e'),
    'callout-warning': variantPaint('#b45309'),
    'callout-danger': variantPaint('#b91c1c'),
    'callout-info': variantPaint(primary),
    'callout-callout': variantPaint(primary),

    // 规则 10：代码卡片（壳画边框，pre 不画；头部是 chrome）
    codeCard: {
      border: `1px solid ${withAlpha(primary, 0.24)}`,
      'border-radius': t.radius,
      overflow: 'hidden',
    },
    pre: { border: 'none', 'border-radius': '0' },
    codeHead: { color: withAlpha(primary, 0.55), 'border-bottom': `1px solid ${rule}` },
    codeLang: { color: withAlpha(primary, 0.55) },

    // 规则 11：表格（斑马纹只能逐行写死——产物里没有 <style>，nth-child 不存在）
    th: {
      'background-color': t.tableStyle === 'card' ? primary : withAlpha(primary, 0.1),
      color: t.tableStyle === 'card' ? accentInk : 'inherit',
      'border-color': rule,
    },
    td: { 'border-color': rule },
    tbodyEven: { 'background-color': soft },

    // 规则 12：列表序号跟主色
    listMarker: { color: primary },

    // 规则 13：分隔线 + 三圆点
    hr: hrPaint(t.hrStyle, primary, rule),
    hrDot: {
      'background-color': withAlpha(primary, 0.7),
      width: '0.26em',
      height: '0.26em',
      'border-radius': '50%',
      display: 'inline-block',
    },

    // 图与图注：有 alt 才渲染 figcaption，但配色定死在这里
    figure: { margin: '1.4em auto', 'max-width': '100%', 'text-align': 'center' },
    figcaption: { 'font-size': '0.82em', 'line-height': '1.6', 'letter-spacing': '0.02em' },

    // 规则 14：xhs 品牌页脚
    cardFooter: { color: withAlpha(primary, 0.55) },
  };
  return slots;
}

function variantPaint(color: string): StyleProps {
  return { 'border-left': `3px solid ${color}`, 'background-color': withAlpha(color, 0.07), color };
}

/** 逐键叠加补丁（主题自带样式在上，派生装饰在下） */
export function mergeSlots(
  base: Record<string, StyleProps>,
  patch: Record<string, StyleProps>,
): Record<string, StyleProps> {
  const out: Record<string, StyleProps> = {};
  for (const [key, props] of Object.entries(base)) out[key] = { ...props };
  for (const [key, props] of Object.entries(patch)) out[key] = { ...(out[key] ?? {}), ...props };
  return out;
}

/**
 * 主题 + overrides → 完整 token 集与最终样式表（渲染层的唯一入口）。
 * `theme` 已是主题对象；派生永远跑，换色只是 overrides 里多了一个 color。
 */
export function resolveThemeSlots(
  theme: Theme,
  overrides: ThemeOverrides,
): { tokens: ResolvedTokens; styles: Record<string, StyleProps> } {
  const tokens = resolveTokens(theme, overrides);
  const slots = derivedSlots(tokens);
  // `${token}` 替换只作用在主题自带样式上；派生槽位里全是字面值（它们就是 token 本身）
  const declared: Record<string, StyleProps> = {};
  for (const [key, props] of Object.entries(theme.styles)) {
    const resolvedProps: StyleProps = {};
    for (const [prop, value] of Object.entries(props)) {
      resolvedProps[prop] = value.replace(/\$\{(\w+)\}/g, (_, name: string) => {
        const hit = (tokens as unknown as Record<string, string>)[name];
        return hit ?? value;
      });
    }
    declared[key] = resolvedProps;
  }
  return { tokens, styles: mergeSlots(declared, slots) };
}

function strongPaint(style: string, primary: string, hl: string): StyleProps {
  const reset: StyleProps = {
    'background-color': 'transparent',
    'background-image': 'none',
    'border-bottom': 'none',
    '-webkit-text-emphasis': 'none',
    'text-emphasis': 'none',
    padding: '0',
  };
  switch (style) {
    case 'highlight':
      return { ...reset, color: primary, 'background-color': hl, padding: '0 0.15em' };
    case 'highlight-bottom':
      return {
        ...reset,
        color: primary,
        'background-image': `linear-gradient(transparent 62%, ${hl} 62%, ${hl} 96%, transparent 96%)`,
        'padding-bottom': '0.05em',
      };
    case 'underline':
      return { ...reset, color: 'inherit', 'border-bottom': `2px solid ${withAlpha(primary, 0.55)}` };
    case 'dot':
      // 中文着重号：中文正文里最地道的强调写法（加粗会让笔画糊成一团）
      return {
        ...reset,
        color: 'inherit',
        '-webkit-text-emphasis': 'dot',
        '-webkit-text-emphasis-position': 'under right',
        'text-emphasis': 'dot',
        'text-emphasis-position': 'under right',
      };
    case 'none':
      return { ...reset, color: 'inherit' };
    case 'color':
    default:
      return { ...reset, color: primary };
  }
}

function headingPaint(
  style: string,
  primary: string,
  rule: string,
  soft: string,
  accentInk: string,
): { block: StyleProps; content: StyleProps; prefix: StyleProps } {
  const block: StyleProps = { ...DECOR_RESET, color: 'inherit' };
  // 内容 span 恒为 inline-block：药丸/下划线要贴着文字走，不撑满版心；
  // box-decoration-break: clone 让荧光笔渐变在标题折行时每行都染上
  const content: StyleProps = { display: 'inline-block', 'box-decoration-break': 'clone' };
  const prefix: StyleProps = { display: 'inline-block' };
  switch (style) {
    case 'left-bar':
      block['border-left'] = `3px solid ${primary}`;
      block['padding-left'] = '0.5em';
      break;
    case 'bottom-line':
      block['border-bottom'] = `2px solid ${primary}`;
      block['padding-bottom'] = '0.25em';
      break;
    case 'boxed':
      block['background-color'] = soft;
      block['border-left'] = `3px solid ${primary}`;
      block.padding = '0.3em 0.6em';
      block['border-radius'] = '4px';
      break;
    case 'pill':
      block.display = 'inline-block';
      block.color = accentInk;
      block['background-color'] = primary;
      block.padding = '0.2em 0.7em';
      block['border-radius'] = '999px';
      break;
    case 'underline-highlight':
      content['background-image'] = `linear-gradient(transparent 60%, ${withAlpha(primary, 0.22)} 60%, ${withAlpha(primary, 0.22)} 94%, transparent 94%)`;
      content['padding-bottom'] = '0.05em';
      break;
    case 'double-line':
      block['border-top'] = `2px solid ${rule}`;
      block['border-bottom'] = `2px solid ${rule}`;
      block.padding = '0.25em 0';
      break;
    case 'section-number':
      block['padding-left'] = '2.2em';
      block.position = 'relative';
      Object.assign(prefix, {
        color: primary,
        'font-weight': '700',
        'letter-spacing': '0.02em',
        'margin-right': '0.45em',
        position: 'absolute',
        left: '0',
      });
      break;
    case 'none':
    default:
      break;
  }
  return { block, content, prefix };
}

function quotePaint(style: string, primary: string, rule: string, soft: string): StyleProps {
  const reset: StyleProps = {
    'border-left': 'none',
    'border-top': 'none',
    'border-bottom': 'none',
    'border-radius': '0',
    'background-color': 'transparent',
    'font-style': 'normal',
    'text-align': 'inherit',
    padding: '0.7em 0.9em',
  };
  switch (style) {
    case 'top-bottom':
      return { ...reset, 'border-top': `1px solid ${rule}`, 'border-bottom': `1px solid ${rule}`, padding: '0.6em 0' };
    case 'quote-mark':
      return { ...reset, 'font-style': 'italic' };
    case 'boxed':
      return {
        ...reset,
        'border-left': `3px solid ${primary}`,
        'background-color': soft,
        'border-radius': '0 8px 8px 0',
      };
    case 'center-accent':
      return {
        ...reset,
        'border-top': `2px solid ${primary}`,
        'border-bottom': `2px solid ${primary}`,
        'text-align': 'center',
      };
    case 'corner-frame':
      return {
        ...reset,
        'border-top': `1px solid ${withAlpha(primary, 0.45)}`,
        'border-bottom': `1px solid ${withAlpha(primary, 0.45)}`,
      };
    case 'left-bar':
    default:
      return { ...reset, 'border-left': `3px solid ${primary}`, 'background-color': soft };
  }
}

function hrPaint(style: string, primary: string, rule: string): StyleProps {
  const color = withAlpha(primary, 0.45);
  const reset: StyleProps = {
    'border-top': 'none',
    'border-bottom': 'none',
    'border-radius': '0',
    height: '2px',
    width: '48px',
    'background-color': primary,
    'background-image': 'none',
    margin: '2em auto',
  };
  switch (style) {
    case 'line':
      return {
        ...reset,
        height: '0',
        width: 'auto',
        'border-top': `1px solid ${rule}`,
        'background-color': 'transparent',
        margin: '1.8em 0',
      };
    case 'dashed':
      return {
        ...reset,
        height: '0',
        width: 'auto',
        'border-top': `1px dashed ${color}`,
        'background-color': 'transparent',
        margin: '1.8em 0',
      };
    case 'dots':
      // 容器只负责排布，三个点是真实 span（颜色在 hrDot 槽）
      return {
        ...reset,
        height: 'auto',
        width: 'auto',
        display: 'flex',
        'justify-content': 'center',
        'align-items': 'center',
        gap: '0.55em',
        padding: '0.35em 0',
        'background-color': 'transparent',
        margin: '1.6em 0',
      };
    case 'pill':
      return {
        ...reset,
        height: '4px',
        width: '20%',
        'border-radius': '999px',
        'background-color': 'transparent',
        'background-image': `linear-gradient(90deg, transparent, ${color}, transparent)`,
        margin: '1.8em auto',
      };
    case 'short':
    default:
      return reset;
  }
}

/**
 * `deriveTheme(base, primary)`：色盘一键换色的公开入口。
 *
 * 仍然返回 Theme（tests/宿主都按主题对象用），但语义变成「tokens 换主色 + 把派生槽位
 * 叠进去」。非 hex 主色原样返回基题（不派生、不炸）。
 */
export function deriveTheme(base: Theme, primary: string): Theme {
  if (!isHexColor(primary)) return base;
  const tokens = resolveTokens(base, { color: primary });
  const declared: ThemeTokens = { ...declaredTokens(base), color: primary };
  return { ...base, tokens: declared, styles: mergeSlots(base.styles, derivedSlots(tokens)) };
}

/**
 * overrides.color 的单一通道：合法 hex 走整套餐派生，非法值按普通 token 覆盖
 * （不派生、不炸）。
 */
export function themeWithOverrides(theme: Theme | string, overrides: ThemeOverrides): Theme {
  const resolved = typeof theme === 'string' ? getTheme(theme) : theme;
  const color = overrides.color;
  if (color && isHexColor(color)) return deriveTheme(resolved, color);
  return resolved;
}