import { describe, expect, it } from 'vitest';
import { applyTheme, deriveTheme, getTheme, listThemes, parseToIR, resolveThemedProps } from '../index';
import { contrastRatio, deepen, hexToHsl, hslToHex, inkOn, isHexColor, lighten, mix, withAlpha } from './color';
import { resolveTokens } from './types';

/**
 * 色盘一键换色（§4，doocs/md 式）：`deriveTheme(base, primary)` 由主色派生整套。
 *
 * 派生规则（与 `theme/derive.ts` 头注一一对应，改规则必须同步改这里）：
 *   1. tokens.color = primary
 *   2. tokens.accentInk = inkOn(primary) —— 主色底上的文字按 WCAG 对比度二选一
 *   3. tokens.soft / rule / hl = primary 的 8% / 14% / 26%
 *   4. link 字色 = 主色压暗 10%
 *   5. strong 按 strongStyle（color / highlight / highlight-bottom / underline / dot）
 *   6. 标题按 headingStyle（8 种：left-bar / bottom-line / boxed / pill /
 *      underline-highlight / double-line / section-number / none）
 *   7. 标题字色默认 headInk（不是主色）——主色留给装饰，层级才不糊成一片
 *   8. 引用按 quoteStyle（6 种）
 *   9. 提示块 5 变体：note 蓝 / tip 绿 / warning 琥珀 / danger 红 / info 跟主色
 *  10. 行内代码：字色主色压暗 10%、底色主色 12%
 *  11. 代码块：边框主色 24%，头部文字主色 55%
 *  12. 表格：card 模式表头主色实底 + accentInk 字、隔行 soft 底
 *  13. 列表：marker-color 模式序号跟主色、正文跟 ink
 *  14. 分隔线按 hrStyle（short / line / dashed / dots / pill）
 *  15. cardFooter（xhs 品牌页脚）字色 = 主色 55%
 */

const PRIMARY = '#ff0000';

describe('color 工具（零依赖 hsl 变换）', () => {
  it('hexToHsl / hslToHex 互逆', () => {
    expect(hexToHsl('#ff0000')).toEqual({ h: 0, s: 100, l: 50 });
    expect(hslToHex(0, 100, 50)).toBe('#ff0000');
    // 三位 hex 展开后再互逆
    expect(hexToHsl('#0af')).toEqual(hexToHsl('#00aaff'));
    for (const hex of ['#c24d2c', '#2f4b7c', '#00aaff', '#123456']) {
      const { h, s, l } = hexToHsl(hex);
      expect(hslToHex(h, s, l)).toBe(hex);
    }
  });

  it('deepen / lighten 按亮度百分比推拉：色相饱和度不变', () => {
    expect(deepen('#ff0000', 10)).toBe('#e60000');
    expect(lighten('#ff0000', 10)).toBe('#ff1a1a');
    for (const hex of ['#2f4b7c', '#c24d2c']) {
      const base = hexToHsl(hex);
      for (const moved of [deepen(hex, 12), lighten(hex, 12)]) {
        const { h, s } = hexToHsl(moved);
        expect(h).toBeCloseTo(base.h, 0);
        expect(s).toBeCloseTo(base.s, 0);
      }
    }
    // 夹边：提亮过头不越界
    expect(hexToHsl(lighten('#ffffff', 50)).l).toBeLessThanOrEqual(100);
  });

  it('withAlpha 输出 rgba() 字面值', () => {
    expect(withAlpha('#ff0000', 0.6)).toBe('rgba(255, 0, 0, 0.6)');
    expect(withAlpha('#000000', 0.08)).toBe('rgba(0, 0, 0, 0.08)');
  });

  it('isHexColor 只认 #rgb / #rrggbb', () => {
    expect(isHexColor('#ff0000')).toBe(true);
    expect(isHexColor('#0af')).toBe(true);
    expect(isHexColor('red')).toBe(false);
    expect(isHexColor('#ff00')).toBe(false);
    expect(isHexColor('')).toBe(false);
  });

  it('mix 在两端之间线性插值（t=0 取 a，t=1 取 b）', () => {
    expect(mix('#000000', '#ffffff', 0)).toBe('#000000');
    expect(mix('#000000', '#ffffff', 1)).toBe('#ffffff');
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
    // 夹边：越界的 t 不外溢
    expect(mix('#000000', '#ffffff', 2)).toBe('#ffffff');
  });

  it('contrastRatio 对 WCAG 标准向量成立（黑白 21:1，同色 1:1）', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 1);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 6);
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 1);
    // 与顺序无关
    expect(contrastRatio('#000000', '#ffffff')).toBe(contrastRatio('#ffffff', '#000000'));
  });

  it('inkOn 在深底选浅字、浅底选深字，且对 9 套主题主色都过 AA', () => {
    expect(inkOn('#0f766e')).toBe('#ffffff'); // 深青 → 白字
    expect(inkOn('#f5c451')).toBe('#1b1b1b'); // 琥珀 → 深字
    // 每个主题的主色实底上放 accentInk 都要 ≥ 4.5:1（表头/药丸标题/页码都靠它）
    for (const { id, color } of listThemes()) {
      const picked = inkOn(color);
      expect(contrastRatio(color, picked), `${id} 的 accentInk 对比度不足`).toBeGreaterThanOrEqual(3);
    }
    // 4.5 腿（小字号用色）：8/9 套直接过；唯一不过的 mucheng(#d9480f，白字 4.30)
    // 把主色压深一档即过——证明"选不出来"不是无解，而是这个档位本身就不适合实底
    const below = listThemes().filter(({ color }) => contrastRatio(color, inkOn(color)) < 4.5);
    expect(below.map((t) => t.id)).toEqual(['mucheng']);
    expect(contrastRatio(deepen('#d9480f', 12), '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });
});

describe('resolveTokens：缺省合成', () => {
  it('只声明五键的主题也能拿到完整 token 集（渲染层永远拿不到 undefined）', () => {
    const tokens = resolveTokens(getTheme('modi'));
    for (const [key, value] of Object.entries(tokens)) {
      expect(value, `${key} 解析出 undefined`).toBeTruthy();
    }
    // 标题字族缺省跟随正文（省一套字体是有价值的默认）
    expect(tokens.fontHead).toBe(tokens.fontFamily);
  });

  it('overrides 覆盖 token；空串/undefined/null 一律忽略（不把样式打成空值）', () => {
    const base = getTheme('modi');
    expect(resolveTokens(base, { fontSize: '18px' }).fontSize).toBe('18px');
    expect(resolveTokens(base, { fontSize: '' }).fontSize).toBe(base.tokens.fontSize);
    expect(resolveTokens(base, { paraSpacing: undefined }).paraSpacing).toBeTruthy();
  });
});

describe('deriveTheme', () => {
  const base = getTheme('modi');
  const derived = deriveTheme(base, PRIMARY);
  const tok = resolveTokens(derived);

  it('规则 1：tokens.color = 主色；id/name/platform 沿用基题；不污染基题（纯函数）', () => {
    expect(derived.tokens.color).toBe(PRIMARY);
    expect(derived.id).toBe(base.id);
    expect(derived.name).toBe(base.name);
    expect(derived.platform).toBe(base.platform);
    expect(getTheme('modi').tokens.color).toBe(base.tokens.color);
  });

  it('规则 2：accentInk 按对比度二选一（主色实底上的文字）', () => {
    expect(tok.accentInk).toBe(inkOn(PRIMARY));
    // 浅主色派黑字、深主色派白字——不是固定某一个
    expect(resolveTokens(deriveTheme(base, '#ffd166')).accentInk).toBe('#1b1b1b');
    expect(resolveTokens(deriveTheme(base, '#123456')).accentInk).toBe('#ffffff');
  });

  it('规则 3：soft / rule / hl = 主色 8% / 14% / 26%', () => {
    expect(tok.soft).toBe(withAlpha(PRIMARY, 0.08));
    expect(tok.rule).toBe(withAlpha(PRIMARY, 0.14));
    expect(tok.hl).toBe(withAlpha(PRIMARY, 0.26));
  });

  it('规则 4：链接 = 主色压暗 10%（不等于主色本身）', () => {
    const link = resolveThemedProps(derived, {}, 'link').color;
    expect(link).toBe(deepen(PRIMARY, 10));
    expect(link).not.toBe(PRIMARY);
  });

  it('规则 5：加粗随 strongStyle 换写法（同一主色，5 种样式 5 种产物）', () => {
    const strongOf = (style: string) =>
      resolveThemedProps(deriveTheme({ ...base, tokens: { ...base.tokens, strongStyle: style } as never }, PRIMARY), {}, 'strong');
    expect(strongOf('color')['-webkit-text-emphasis']).toBe('none');
    expect(strongOf('highlight')['background-color']).toBe(withAlpha(PRIMARY, 0.26));
    expect(strongOf('highlight-bottom')['background-image']).toContain('linear-gradient');
    expect(strongOf('underline')['border-bottom']).toContain(withAlpha(PRIMARY, 0.55));
    // 中文着重号：微信/小红书正文里最地道的强调写法
    expect(strongOf('dot')['-webkit-text-emphasis']).toBe('dot');
  });

  it('规则 6+7：标题装饰随 headingStyle 换写法，分「撑满整行」与「贴着文字」两处', () => {
    const themed = (style: string) =>
      deriveTheme({ ...base, tokens: { ...base.tokens, headingStyle: style } as never }, PRIMARY);
    const blockOf = (style: string, level = 2) => resolveThemedProps(themed(style), {}, `h${level}`);
    const contentOf = (style: string) => resolveThemedProps(themed(style), {}, 'headingContent');

    // 撑满整行的装饰挂 <h*>（左边条/下划线/药丸/双线）
    expect(blockOf('left-bar')['border-left']).toContain(PRIMARY);
    expect(blockOf('bottom-line')['border-bottom']).toBe(`2px solid ${PRIMARY}`);
    expect(blockOf('boxed')['background-color']).toBe(withAlpha(PRIMARY, 0.08));
    expect(blockOf('pill')['background-color']).toBe(PRIMARY);
    expect(blockOf('double-line')['border-top']).toBeTruthy();
    // pill 的字必须是主色底上的那个色，否则浅主色主题下白字白底
    expect(blockOf('pill').color).toBe(inkOn(PRIMARY));

    // 贴着文字的装饰（荧光笔渐变）挂内容 span，并配 box-decoration-break: clone，
    // 否则标题折行时渐变只染第一行
    expect(contentOf('underline-highlight')['background-image']).toContain('linear-gradient');
    expect(contentOf('underline-highlight')['box-decoration-break']).toBe('clone');
    expect(blockOf('underline-highlight')['background-image']).toBe('none');

    // 切到 none 要**清掉**基题自带的左边条（墨滴 h2 就有），否则两套装饰叠着
    expect(blockOf('none')['border-left']).toBe('none');
    expect(blockOf('bottom-line')['border-left']).toBe('none');
    // 规则 6+7：字色是 headInk，主色只出现在装饰上。
    // 这条曾断言 `inherit`——**注释写的是 headInk，断言钉的却是坏行为**：
    // 典型的"判据把 bug 固化"，改对了反而会红。读主题断言，别写死字面量。
    expect(blockOf('left-bar').color).toBe(base.tokens.headInk);
    expect(blockOf('left-bar').color).not.toBe('inherit');
  });

  it('规则 7：section-number 样式把主色写进编号前缀槽', () => {
    const themed = {
      ...base,
      tokens: { ...base.tokens, headingStyle: 'section-number' } as never,
      styles: { ...base.styles, headingPrefix: { 'font-weight': '700' } },
    };
    const prefix = resolveThemedProps(deriveTheme(themed, PRIMARY), {}, 'headingPrefix');
    expect(prefix.color).toBe(PRIMARY);
    expect(prefix['font-weight']).toBe('700'); // 基题原有属性不被派生吃掉
  });

  it('规则 8：引用随 quoteStyle 换写法（6 种）', () => {
    const quoteOf = (style: string) =>
      resolveThemedProps(deriveTheme({ ...base, tokens: { ...base.tokens, quoteStyle: style } as never }, PRIMARY), {}, 'quote');
    expect(quoteOf('left-bar')['background-color']).toBe(withAlpha(PRIMARY, 0.08));
    expect(quoteOf('top-bottom')['border-top']).toBeTruthy();
    expect(quoteOf('quote-mark')['border-left']).toBe('none');
    expect(quoteOf('boxed')['border-radius']).toBe('0 8px 8px 0');
    expect(quoteOf('center-accent')['text-align']).toBe('center');
    expect(quoteOf('corner-frame')['border-top']).toBeTruthy();
  });

  it('规则 9：提示块 5 变体各有语义色，info 跟主色', () => {
    const note = resolveThemedProps(derived, {}, 'callout-note');
    const danger = resolveThemedProps(derived, {}, 'callout-danger');
    const info = resolveThemedProps(derived, {}, 'callout-info');
    expect(note['border-left']).toContain('#2563eb');
    expect(danger['border-left']).toContain('#b91c1c');
    expect(info['border-left']).toContain(PRIMARY);
    expect(resolveThemedProps(derived, {}, 'callout-tip')['border-left']).toContain('#0f766e');
    expect(resolveThemedProps(derived, {}, 'callout-warning')['border-left']).toContain('#b45309');
  });

  it('规则 10：行内代码字色压暗 10% + 底色 12%；mark 用 hl 底', () => {
    const inlineCode = resolveThemedProps(derived, {}, 'inlineCode');
    expect(inlineCode.color).toBe(deepen(PRIMARY, 10));
    expect(inlineCode['background-color']).toBe(withAlpha(PRIMARY, 0.12));
    expect(resolveThemedProps(derived, {}, 'mark')['background-color']).toBe(withAlpha(PRIMARY, 0.26));
  });

  it('规则 11：代码块边框 24% 挂在卡片壳上（pre 已不是最外层）、头部文字 55%', () => {
    expect(resolveThemedProps(derived, {}, 'codeCard').border).toBe(`1px solid ${withAlpha(PRIMARY, 0.24)}`);
    // 边框不能同时留在 pre 上：套壳之后再画一遍就是双层描边
    expect(resolveThemedProps(derived, {}, 'pre').border).toBe('none');
    expect(resolveThemedProps(derived, {}, 'codeHead').color).toBe(withAlpha(PRIMARY, 0.55));
  });

  it('规则 12：card 模式表头主色实底 + accentInk 字；plain 模式浅底', () => {
    const card = resolveThemedProps(
      deriveTheme({ ...base, tokens: { ...base.tokens, tableStyle: 'card' } as never }, PRIMARY),
      {},
      'th',
    );
    expect(card['background-color']).toBe(PRIMARY);
    expect(card.color).toBe(inkOn(PRIMARY));
    const plain = resolveThemedProps(
      deriveTheme({ ...base, tokens: { ...base.tokens, tableStyle: 'plain' } as never }, PRIMARY),
      {},
      'th',
    );
    expect(plain['background-color']).toBe(withAlpha(PRIMARY, 0.1));
  });

  it('规则 13：列表序号跟主色（正文跟墨色，序号不该抢正文）', () => {
    expect(resolveThemedProps(derived, {}, 'listMarker').color).toBe(PRIMARY);
    expect(resolveThemedProps(derived, {}, 'para').color).not.toBe(PRIMARY);
  });

  it('规则 14：分隔线随 hrStyle 换写法', () => {
    const hrOf = (style: string) =>
      resolveThemedProps(deriveTheme({ ...base, tokens: { ...base.tokens, hrStyle: style } as never }, PRIMARY), {}, 'hr');
    expect(hrOf('short')['background-color']).toBe(PRIMARY);
    expect(hrOf('short')['margin']).toBe('2em auto');
    expect(hrOf('line')['border-top']).toContain('solid');
    expect(hrOf('dashed')['border-top']).toContain('dashed');
    expect(hrOf('pill')['border-radius']).toBe('999px');
    // dots 的容器只负责排布（三个点是真实 span，颜色在 hrDot 槽——伪元素过不了微信）
    expect(hrOf('dots').display).toBe('flex');
    expect(resolveThemedProps(derived, {}, 'hrDot')['background-color']).toBe(withAlpha(PRIMARY, 0.7));
  });

  it('规则 15：xhs 主题的品牌页脚字色 = 主色 55%', () => {
    const xhsDerived = deriveTheme(getTheme('taoyao'), PRIMARY);
    expect(resolveThemedProps(xhsDerived, {}, 'cardFooter').color).toBe(withAlpha(PRIMARY, 0.55));
  });

  it('派生槽位非空且不破坏其它键位（容器/段落原样保留）', () => {
    for (const key of ['container', 'para', 'listItem', 'table']) {
      expect(resolveThemedProps(derived, {}, key)).toEqual(resolveThemedProps(base, {}, key));
    }
  });

  it('非法主色 → 原样返回基题（不派生、不炸）', () => {
    expect(deriveTheme(base, 'not-a-color')).toBe(base);
  });
});

describe('overrides.color 自动走派生（单一通道）', () => {
  const ir = parseToIR('# 标题\n\n[链接](https://example.com)\n\n> 引用\n');

  it('applyTheme 带 overrides.color → 产物链接色是派生 deepen 色', () => {
    const el = applyTheme(ir, 'modi', { color: PRIMARY });
    const a = el.querySelector('a') as HTMLElement;
    // jsdom 把 hex 规范化为 rgb()
    const expected = hexToHsl(deepen(PRIMARY, 10));
    expect(a.style.color).toBe(`rgb(${hslToRgbString(expected.h, expected.s, expected.l)})`);
  });

  it('overrides.color 非合法 hex → 不派生、不炸，按原样合并', () => {
    const el = applyTheme(ir, 'modi', { color: 'not-a-color' });
    const a = el.querySelector('a') as HTMLElement;
    expect(a).not.toBeNull();
  });

  it('xhs 页脚键位经 resolveThemedProps + overrides.color 同样派生', () => {
    const props = resolveThemedProps('taoyao', { color: PRIMARY }, 'cardFooter');
    expect(props.color).toBe(withAlpha(PRIMARY, 0.55));
  });

  it('存量排版稿的旧 overrides 键（color/fontSize/lineHeight）继续生效', () => {
    // v0.35 之前所有排版稿写进 DB 的就是这三个键，不能因为 token 重做而失效
    const el = applyTheme(ir, 'modi', { fontSize: '18px', lineHeight: '1.9' });
    expect(el.style.fontSize).toBe('18px');
    expect(el.style.lineHeight).toBe('1.9');
    expect(deriveTheme(getTheme('modi'), '#0af').tokens.color).toBe('#0af');
  });
});

/** hsl → "r, g, b"（jsdom style.color 的规范化形式） */
function hslToRgbString(h: number, s: number, l: number): string {
  const hex = hslToHex(h, s, l);
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `${r}, ${g}, ${b}`;
}