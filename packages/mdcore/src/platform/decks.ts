/**
 * 卡片装饰库（切片 5）。
 *
 * 为什么全部是**内联 SVG data URL + 纯 CSS 盒**：参考实现用 PNG 资源 + CSS 类，
 * 但我们有一条硬纪律——排版基线图必须像素稳定、可重录、可逐像素比对。外链 PNG
 * 在换机/换字体时会飘，纹理一变整张基线作废；内联 SVG 无外部依赖，尺寸写死，
 * 重录结果一致。
 *
 * 两条分工：
 * - **纹理（bgImage）**：铺满整页、与底色正片叠底（`background-blend-mode: multiply`
 *   由页壳负责），负责"这是纸"。
 * - **装饰件（deco）**：贴边的实体（胶带、状态栏、横线），负责"这是谁家的纸"。
 *   两者都绝对定位，不进测量流（见 paginate 的 CardChrome）。
 */
import type { CardChrome } from '../paginate/paginate';

/** SVG → data URL（统一 encode：卡片产物里不能出现裸引号/尖括号） */
function svgUrl(body: string, size: { w: number; h: number }): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size.w}" height="${size.h}" viewBox="0 0 ${size.w} ${size.h}">${body}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export type TextureId = 'none' | 'grid' | 'dots' | 'lines' | 'mesh' | 'kraft';

export interface CardTexture {
  bgImage: string;
  bgSize: string;
  bgRepeat: 'repeat' | 'no-repeat';
  /** 纹理不透明度（0~1）：深色主题上浅纹会显脏 */
  opacity: number;
}

const INK = '%23000';

/** 纹理库：每张都是可无缝平铺的定尺寸图案 */
const TEXTURES: Record<Exclude<TextureId, 'none'>, (color: string) => Omit<CardTexture, 'opacity'>> = {
  // 方格纸（学习笔记）
  grid: (color) => ({
    bgImage: svgUrl(
      `<path d='M40 0V40M0 40H40' stroke='${color}' stroke-opacity='0.16' stroke-width='1'/>` +
        `<path d='M8 0V40M0 8H40' stroke='${color}' stroke-opacity='0.07' stroke-width='1'/>`,
      { w: 40, h: 40 },
    ),
    bgSize: '40px 40px',
    bgRepeat: 'repeat',
  }),
  // 点阵纸（手帐）
  dots: (color) => ({
    bgImage: svgUrl(
      `<circle cx='2' cy='2' r='1.6' fill='${color}' fill-opacity='0.16'/>`,
      { w: 24, h: 24 },
    ),
    bgSize: '24px 24px',
    bgRepeat: 'repeat',
  }),
  // 横线纸（信笺）
  lines: (color) => ({
    bgImage: svgUrl(`<path d='M0 0.5H48' stroke='${color}' stroke-opacity='0.13' stroke-width='1'/>`, {
      w: 48,
      h: 48,
    }),
    bgSize: '48px 48px',
    bgRepeat: 'repeat',
  }),
  // 细密网格（票据/学术）
  mesh: (color) => ({
    bgImage: svgUrl(
      `<path d='M16 0V16M0 16H16' stroke='${color}' stroke-opacity='0.09' stroke-width='1'/>`,
      { w: 16, h: 16 },
    ),
    bgSize: '16px 16px',
    bgRepeat: 'repeat',
  }),
  // 纸纤维（牛皮纸质感）：两层随机短划 + 噪点
  kraft: (color) => ({
    bgImage: svgUrl(
      `<path d='M2 6l10-2M22 14l12-3M8 26l14-4M30 30l12-3M2 38l9-2M20 44l14-3' stroke='${color}' stroke-opacity='0.07' stroke-width='1.2' stroke-linecap='round'/>` +
        `<circle cx='14' cy='16' r='1' fill='${color}' fill-opacity='0.06'/>` +
        `<circle cx='34' cy='8' r='1' fill='${color}' fill-opacity='0.06'/>` +
        `<circle cx='6' cy='30' r='1' fill='${color}' fill-opacity='0.06'/>` +
        `<circle cx='26' cy='40' r='1' fill='${color}' fill-opacity='0.06'/>`,
      { w: 48, h: 48 },
    ),
    bgSize: '48px 48px',
    bgRepeat: 'repeat',
  }),
};

/** 取纹理；`color` 是墨色（深色主题要传浅色，否则纹理会显脏） */
export function cardTexture(id: TextureId, color = INK, opacity = 1): CardTexture | null {
  if (id === 'none') return null;
  const make = TEXTURES[id];
  if (!make) return null;
  return { ...make(color), opacity };
}

export const TEXTURE_IDS: TextureId[] = ['none', 'grid', 'dots', 'lines', 'mesh', 'kraft'];

export const TEXTURE_LABELS: Record<TextureId, string> = {
  none: '纯色',
  grid: '方格纸',
  dots: '点阵纸',
  lines: '横线纸',
  mesh: '细网格',
  kraft: '牛皮纸',
};

/* -------------------------------------------------------------- 装饰件 */

type DecoItem = NonNullable<CardChrome['deco']>[number];

/**
 * 和纸胶带：一段半透明斜纹胶带。
 *
 * 颜色直接写 `#rrggbb`——装饰件是 innerHTML 注入的（不走 data URL），
 * 早先按 data URL 的习惯手写 `%23d9a066`，浏览器不解码，胶带就渲染成了黑块。
 */
function tape(color: string, rotation = -3): string {
  return `<svg width="260" height="64" viewBox="0 0 260 64" xmlns="http://www.w3.org/2000/svg">
    <g transform="rotate(${rotation} 130 32)">
      <rect x="0" y="14" width="260" height="36" fill="${color}" fill-opacity="0.55"/>
      <path d="M0 14h260M0 50h260" stroke="${color}" stroke-opacity="0.35" stroke-width="1"/>
    </g>
  </svg>`;
}

/** 备忘录状态栏：时间 + 信号 + 电量（纯几何，不含字形——字形会随字体漂） */
function statusBar(ink: string): string {
  return `<svg width="720" height="56" viewBox="0 0 720 56" xmlns="http://www.w3.org/2000/svg" fill="${ink}">
    <rect x="600" y="20" width="6" height="16" rx="2"/><rect x="612" y="14" width="6" height="22" rx="2"/>
    <rect x="624" y="8" width="6" height="28" rx="2"/><rect x="640" y="16" width="52" height="20" rx="5" fill-opacity="0.3"/>
    <rect x="644" y="20" width="40" height="12" rx="3"/>
    <rect x="698" y="20" width="16" height="10" rx="2"/>
  </svg>`;
}

/** 底部工具栏（备忘录同款）：一排几何图标 */
function toolBar(ink: string): string {
  const circle = (cx: number): string =>
    `<circle cx="${cx}" cy="28" r="22" fill="none" stroke="${ink}" stroke-opacity="0.45" stroke-width="4"/>`;
  return `<svg width="420" height="56" viewBox="0 0 420 56" xmlns="http://www.w3.org/2000/svg">
    ${[40, 140, 240, 340].map(circle).join('')}
    <path d="M232 28l8 9 16-19" fill="none" stroke="${ink}" stroke-opacity="0.55" stroke-width="4" stroke-linecap="round"/>
    <path d="M330 20h20v18h-20z" fill="none" stroke="${ink}" stroke-opacity="0.45" stroke-width="3"/>
  </svg>`;
}

export interface DecoPreset {
  id: string;
  label: string;
  /** 贴边装饰件（进 CardChrome.deco） */
  deco: DecoItem[];
}

/** 装饰件预设：主题按「性格」挑一套，装饰件因此也是主题身份的一部分 */
export const DECO_PRESETS: Record<string, DecoPreset> = {
  none: { id: 'none', label: '无装饰', deco: [] },
  tape: {
    id: 'tape',
    label: '和纸胶带',
    deco: [
      { html: tape('#d9a066'), anchor: 'top', align: 'start', inset: -1.5, span: 24, z: 2 },
      { html: tape('#c9b7a0', 4), anchor: 'bottom', align: 'end', inset: -1.2, span: 20, z: 2 },
    ],
  },
  memo: {
    id: 'memo',
    label: '备忘录',
    deco: [
      { html: statusBar('#8c8c8c'), anchor: 'top', align: 'center', inset: 1.2, span: 62, z: 1 },
      { html: toolBar('#8c8c8c'), anchor: 'bottom', align: 'center', inset: 0.8, span: 42, z: 1 },
    ],
  },
  magazine: {
    id: 'magazine',
    label: '杂志',
    deco: [
      {
        html: `<svg width="880" height="10" viewBox="0 0 880 10" xmlns="http://www.w3.org/2000/svg"><rect width="880" height="3" fill="currentColor"/><rect y="7" width="880" height="1" fill="currentColor" fill-opacity="0.5"/></svg>`,
        anchor: 'top',
        align: 'center',
        inset: 2.2,
        span: 78,
        z: 1,
      },
    ],
  },
};

export const DECO_IDS = Object.keys(DECO_PRESETS);

export function decoPreset(id: string): DecoPreset {
  return DECO_PRESETS[id] ?? DECO_PRESETS.none;
}