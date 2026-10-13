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

export function withAlpha(hex: string, alpha: number): string {
  const s = expand(hex).toLowerCase();
  const r = parseInt(s.slice(0, 2), 16);
  const g = parseInt(s.slice(2, 4), 16);
  const b = parseInt(s.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
