import type { StyleProps, Theme, ThemeOverrides } from './types';
import { deepen, isHexColor, withAlpha } from './color';
import { getTheme } from './index';

/**
 * 色盘一键换色（§4，doocs/md 式）：deriveTheme(base, primary) 由主色派生整套。
 * 派生规则（与 derive.test.ts 头注一一对应，改规则必须同步改测试）：
 *  1. tokens.color = primary —— 标题/强调色 = 主色（${color} 引用自然跟随）
 *  2. h1..h6 / strong 的 color 强制 = 主色
 *  3. link 的 color = 主色 deepen 10%
 *  4. quote 左边条 = 主色 60% 透明；底色 = 主色 8% 透明
 *  5. callout 左边条 = 主色 60% 透明
 *  6. inlineCode 字色 = 主色；底色 = 主色 12% 透明
 *  7. pre 点缀边框 = 主色 35% 透明
 *  8. th 表头底色 = 主色 10% 透明
 *  9. cardFooter（xhs 品牌页脚，若存在）字色 = 主色 55% 透明
 * 纯函数：不改动基题。
 */
export function deriveTheme(base: Theme, primary: string): Theme {
  if (!isHexColor(primary)) return base;
  const styles: Record<string, StyleProps> = {};
  for (const [key, props] of Object.entries(base.styles)) {
    styles[key] = { ...props };
  }
  const paint = (key: string, patch: StyleProps): void => {
    if (styles[key]) styles[key] = { ...styles[key], ...patch };
  };

  paint('h1', { color: primary });
  paint('h2', { color: primary });
  paint('h3', { color: primary });
  paint('h4', { color: primary });
  paint('h5', { color: primary });
  paint('h6', { color: primary });
  paint('strong', { color: primary });
  paint('link', { color: deepen(primary, 10) });
  paint('quote', {
    'border-left': borderWidth(base, 'quote', primary),
    'background-color': withAlpha(primary, 0.08),
  });
  paint('callout', { 'border-left': borderWidth(base, 'callout', primary) });
  paint('inlineCode', { color: primary, 'background-color': withAlpha(primary, 0.12) });
  paint('pre', { border: `1px solid ${withAlpha(primary, 0.35)}` });
  paint('th', { 'background-color': withAlpha(primary, 0.1) });
  paint('cardFooter', { color: withAlpha(primary, 0.55) });

  return { ...base, tokens: { ...base.tokens, color: primary }, styles };
}

/** 保留基题边条的「宽度 solid」结构，只换颜色（宽度取不到则 4px）。 */
function borderWidth(base: Theme, key: string, primary: string): string {
  const raw = base.styles[key]?.['border-left'] ?? '';
  const width = /(\d+(?:\.\d+)?px)\s+solid/.exec(raw)?.[1] ?? '4px';
  return `${width} solid ${withAlpha(primary, 0.6)}`;
}

/**
 * overrides.color 的单一通道：合法 hex 走整套餐派生，
 * 非法值按普通 token 覆盖（不派生、不炸）。
 */
export function themeWithOverrides(theme: Theme | string, overrides: ThemeOverrides): Theme {
  const resolved = typeof theme === 'string' ? getTheme(theme) : theme;
  const color = overrides.color;
  if (color && isHexColor(color)) return deriveTheme(resolved, color);
  return resolved;
}
