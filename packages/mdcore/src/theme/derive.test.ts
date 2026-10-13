import { describe, expect, it } from 'vitest';
import { applyTheme, deriveTheme, getTheme, parseToIR, resolveThemedProps } from '../index';
import { deepen, hexToHsl, hslToHex, isHexColor, withAlpha } from '../theme/color';

/**
 * 色盘一键换色（§4，doocs/md 式）：deriveTheme(base, primary) 由主色派生整套。
 * 派生规则（与 theme/derive.ts 头注一一对应，改规则必须同步改这里）：
 *  1. tokens.color = primary —— 标题/强调色 = 主色（${color} 引用自然跟随）
 *  2. h1..h6 / strong 的 color 强制 = 主色（原主题用固定色也覆盖）
 *  3. link 的 color = 主色 hsl 亮度 ×0.9（deepen 10%）
 *  4. quote 左边条 = 主色 60% 透明；底色 = 主色 8% 透明
 *  5. callout 左边条 = 主色 60% 透明
 *  6. inlineCode 字色 = 主色；底色 = 主色 12% 透明
 *  7. pre 点缀边框 = 主色 35% 透明
 *  8. th 表头底色 = 主色 10% 透明
 *  9. cardFooter（xhs 品牌页脚，若存在）字色 = 主色 55% 透明
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

  it('deepen 按亮度百分比压暗：#ff0000 deepen 10% = #e60000', () => {
    expect(deepen('#ff0000', 10)).toBe('#e60000');
    // 饱和度不变、色相不变（hsl→8bit hex 量化的精度内，误差 <0.5°）
    const { h, s } = hexToHsl(deepen('#2f4b7c', 10));
    const base = hexToHsl('#2f4b7c');
    expect(h).toBeCloseTo(base.h, 0);
    expect(s).toBeCloseTo(base.s, 0);
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
});

describe('deriveTheme', () => {
  const base = getTheme('modi');
  const derived = deriveTheme(base, PRIMARY);

  it('tokens.color = 主色；id/name/platform 沿用基题', () => {
    expect(derived.tokens.color).toBe(PRIMARY);
    expect(derived.id).toBe(base.id);
    expect(derived.name).toBe(base.name);
    expect(derived.platform).toBe(base.platform);
    // 不污染基题（纯函数）
    expect(getTheme('modi').tokens.color).toBe(base.tokens.color);
  });

  it('规则 1+2：标题/强调 = 主色', () => {
    for (const key of ['h1', 'h2', 'h3', 'strong']) {
      expect(resolveThemedProps(derived, {}, key).color).toBe(PRIMARY);
    }
  });

  it('规则 3：链接 = 主色 deepen 10%（不等于主色本身）', () => {
    const link = resolveThemedProps(derived, {}, 'link').color;
    expect(link).toBe(deepen(PRIMARY, 10));
    expect(link).not.toBe(PRIMARY);
    expect(link).not.toBe(resolveThemedProps(base, {}, 'link').color);
  });

  it('规则 4：引用左边条 = 主色 60% 透明，底色 = 主色 8% 透明', () => {
    const quote = resolveThemedProps(derived, {}, 'quote');
    expect(quote['border-left']).toContain(withAlpha(PRIMARY, 0.6));
    expect(quote['background-color']).toBe(withAlpha(PRIMARY, 0.08));
    // 保留原边条宽度（4px solid 结构不被派生吃掉的）
    expect(quote['border-left']).toMatch(/^\d+px solid /);
  });

  it('规则 5+6：callout 边条 60% 透明；inlineCode 字色主色 + 底色 12% 透明', () => {
    expect(resolveThemedProps(derived, {}, 'callout')['border-left']).toContain(withAlpha(PRIMARY, 0.6));
    const inlineCode = resolveThemedProps(derived, {}, 'inlineCode');
    expect(inlineCode.color).toBe(PRIMARY);
    expect(inlineCode['background-color']).toBe(withAlpha(PRIMARY, 0.12));
  });

  it('规则 7+8：pre 点缀边框 35% 透明；th 底色 10% 透明', () => {
    expect(resolveThemedProps(derived, {}, 'pre').border).toBe(`1px solid ${withAlpha(PRIMARY, 0.35)}`);
    expect(resolveThemedProps(derived, {}, 'th')['background-color']).toBe(withAlpha(PRIMARY, 0.1));
  });

  it('规则 9：xhs 主题的品牌页脚字色 = 主色 55% 透明', () => {
    const xhsDerived = deriveTheme(getTheme('taoyao'), PRIMARY);
    expect(resolveThemedProps(xhsDerived, {}, 'cardFooter').color).toBe(withAlpha(PRIMARY, 0.55));
  });

  it('派生槽位非空且不破坏其它键位（容器/段落原样保留）', () => {
    for (const key of ['container', 'para', 'list', 'table', 'hr']) {
      expect(resolveThemedProps(derived, {}, key)).toEqual(resolveThemedProps(base, {}, key));
    }
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
    // 非法色不进派生，${color} 被替换为原样字面值（浏览器会丢弃，jsdom 保留或不设均可）
    expect(a).not.toBeNull();
  });

  it('xhs 页脚键位经 resolveThemedProps + overrides.color 同样派生', () => {
    const props = resolveThemedProps('taoyao', { color: PRIMARY }, 'cardFooter');
    expect(props.color).toBe(withAlpha(PRIMARY, 0.55));
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
