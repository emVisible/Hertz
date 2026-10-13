/** 零依赖 hex ↔ hsl 小工具（色盘换色用，§4）。 */

export interface Hsl {
  h: number;
  s: number;
  l: number;
}

export function isHexColor(value: string): boolean {
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value);
}

function expand(hex: string): string {
  const raw = hex.slice(1);
  if (raw.length === 3) {
    return raw
      .split('')
      .map((c) => c + c)
      .join('');
  }
  return raw;
}

export function hexToHsl(hex: string): Hsl {
  const s = expand(hex).toLowerCase();
  const r = parseInt(s.slice(0, 2), 16) / 255;
  const g = parseInt(s.slice(2, 4), 16) / 255;
  const b = parseInt(s.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let sat = 0;
  if (d !== 0) {
    sat = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        break;
      case g:
        h = ((b - r) / d + 2) / 6;
        break;
      default:
        h = ((r - g) / d + 4) / 6;
    }
  }
  // h/s/l 不舍入：中间取整会让 hex↔hsl 往返掉位（#c24d2c → #c34d2c）
  return { h: h * 360, s: sat * 100, l: l * 100 };
}

function channel(value: number): string {
  const clamped = Math.min(1, Math.max(0, value));
  return Math.round(clamped * 255)
    .toString(16)
    .padStart(2, '0');
}

export function hslToHex(h: number, s: number, l: number): string {
  const hh = ((h % 360) + 360) % 360;
  const ss = Math.min(100, Math.max(0, s)) / 100;
  const ll = Math.min(100, Math.max(0, l)) / 100;
  const a = ss * Math.min(ll, 1 - ll);
  const f = (n: number) => {
    const k = (n + hh / 30) % 12;
    return ll - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return `#${channel(f(0))}${channel(f(8))}${channel(f(4))}`;
}

/** 按亮度百分比压暗（pct=10 → L×0.9），色相与饱和度不变。 */
export function deepen(hex: string, pct: number): string {
  const { h, s, l } = hexToHsl(hex);
  return hslToHex(h, s, l * (1 - pct / 100));
}

/** 按亮度百分比提亮（pct=10 → L×1.1 并夹到 100），色相与饱和度不变。 */
export function lighten(hex: string, pct: number): string {
  const { h, s, l } = hexToHsl(hex);
  return hslToHex(h, s, l * (1 + pct / 100));
}

export function withAlpha(hex: string, alpha: number): string {
  const s = expand(hex).toLowerCase();
  const r = parseInt(s.slice(0, 2), 16);
  const g = parseInt(s.slice(2, 4), 16);
  const b = parseInt(s.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function channels(hex: string): [number, number, number] {
  const s = expand(hex).toLowerCase();
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

/** 两色线性混合（t=0 取 a，t=1 取 b），走 sRGB 通道而非 HSL——混的是"墨色向主色靠一点"这种量。 */
export function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = channels(a);
  const [r2, g2, b2] = channels(b);
  const k = Math.min(1, Math.max(0, t));
  const ch = (x: number, y: number) => Math.round(x + (y - x) * k).toString(16).padStart(2, '0');
  return `#${ch(r1, r2)}${ch(g1, g2)}${ch(b1, b2)}`;
}

/** WCAG 2.1 相对亮度（sRGB 去伽马） */
export function relativeLuminance(hex: string): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = channels(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 2.1 对比度（1 ~ 21），与顺序无关 */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** 主色底上的文字色：深墨 `#1b1b1b` 与白里挑对比度更高的那个。 */
export const INK_DARK = '#1b1b1b';
export const INK_LIGHT = '#ffffff';

/**
 * 主色底该配什么字色（xhs `inkOn()` 的升级版）。
 *
 * 参考实现用感知亮度 0.2126r+0.7152g+0.0722b > 0.62 判断黑/白；这里改用 WCAG
 * 相对亮度算**对比度**再二选一——感知亮度没有对比度的量纲，阈值 0.62 是拍出来的，
 * 而 `accentInk` 会出现在表头、药丸标题、页码等实底元素上，选错就是"看不清"。
 * 判据见 `color.test.ts`（对 WCAG 标准向量 + 9 套主题的主色逐个断言）。
 */
export function inkOn(bg: string): string {
  return contrastRatio(bg, INK_DARK) >= contrastRatio(bg, INK_LIGHT) ? INK_DARK : INK_LIGHT;
}
