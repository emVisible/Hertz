/**
 * @hertz/mdcore —— 超级 Markdown 模块内核（切片 A + B + C）。
 * 管线：parseToIR(md) → LayoutIR → applyTheme(ir, theme, overrides) → 渲染态 DOM
 *       → wechatPayload(dom) → { html, text } → copyForWechat(...)
 *       → zhihuPayload(dom) → { html, text } → copyForZhihu(...)（§3.2 降级渲染器）
 *       → paginate(ir, { page }) → 卡片页 DOM[] → xhsCards（封面/页脚/上限）
 *       → exportCards / exportZip（PNG / ZIP）
 *       → renderLongImage（≤8192px 切片渲染再拼总 canvas，§2 长图）
 *
 * 切片 C 复用约定：
 * - 长图导出 renderLongImage（export/longimage.ts）：渲染态容器 → 单张长图 Blob；
 * - 知乎适配器与微信/xhs 一样只认 LayoutIR + 渲染态 DOM；
 * - 分页器以 LayoutIR + 渲染态 DOM 为输入，不回读 markdown-it token；
 * - 导出器以 applyTheme/paginate 的渲染态 DOM 为截图源（§1 铁律 3）。
 */
export { createMarkdownParser, getMarkdownParser } from './parse/markdown';
export { CALLOUT_TITLES, parseToIR, tokensToIR, convertInline } from './ir/parseToIR';
export type { IRBlock, IRBlockType, InlineNode, LayoutIR, LineRange } from './ir/types';
export { applyTheme, cjkNumeral, resolveThemedProps } from './theme/apply';
export { deriveTheme, derivedSlots, mergeSlots, resolveThemeSlots, themeWithOverrides } from './theme/derive';
export {
  CODE_BARS,
  HEADING_STYLES,
  HR_STYLES,
  LIST_STYLES,
  QUOTE_STYLES,
  STRONG_STYLES,
  TABLE_STYLES,
  TOKEN_DEFAULTS,
  declaredTokens,
  resolveTokens,
} from './theme/types';
export type {
  CodeBar,
  HeadingStyle,
  HrStyle,
  ListStyle,
  QuoteStyle,
  ResolvedTokens,
  StrongStyle,
  TableStyle,
} from './theme/types';
export { deepen, hexToHsl, hslToHex, isHexColor, withAlpha } from './theme/color';
export {
  darkThemeFor,
  defaultThemeFor,
  getTheme,
  listThemes,
  moan,
  modi,
  mucheng,
  qingjian,
  qingning,
  resolveTheme,
  taoyao,
  wanfeng,
  xueshu,
  yehang,
} from './theme/index';
export type { StyleProps, Theme, ThemeOverrides, ThemePlatform, ThemeTokens } from './theme/types';
export { copyToClipboard, toWechatClipboardPayload } from './platform/wechat';
export type { WechatPayload } from './platform/wechat';
export { toZhihuClipboardPayload } from './platform/zhihu';
export type { TableCapture, ZhihuOptions, ZhihuPayload } from './platform/zhihu';
export { panguSpacing, panguSpacingDOM } from './platform/pangu';
// 切片 B：分页引擎（测量可注入）
export { domMeasurer, paginate } from './paginate/paginate';
export type { Measurer, PagePadding, PageSpec, PaginateOptions } from './paginate/paginate';
export { adjustBreak, codeBreak, NO_END, NO_START } from './paginate/breaks';
// 切片 B：小红书适配
export { scaleFontSize, XHS_CARD, XHS_MAX_PAGES, xhsCaption, xhsCards } from './platform/xhs';
export type { XhsCaptionOptions, XhsOptions, XhsResult } from './platform/xhs';
// 切片 B：导出器（分页 PNG / ZIP）
export {
  createBrowserReadyGate,
  createDefaultCapture,
  exportCards,
  exportCardsDetailed,
  exportZip,
  isCanvasTooLargeError,
  SCALE_LADDER,
  zipBlobs,
} from './export/exporter';
export type { CaptureEngine, ExportCardsResult, ExportOptions, ReadyGate } from './export/exporter';
// 切片 C：长图导出（≤8192px 切片渲染再拼总 canvas）
export {
  createDefaultSliceCapture,
  LONG_IMAGE_MAX_AREA,
  LONG_IMAGE_MAX_DIM,
  LONG_IMAGE_SLICE_HEIGHT,
  renderLongImage,
  renderLongImageDetailed,
} from './export/longimage';
export type {
  CanvasLike,
  Context2dLike,
  LongImageOptions,
  LongImageResult,
  SliceCaptureEngine,
} from './export/longimage';

import { applyTheme } from './theme/apply';
import { defaultThemeFor, resolveTheme } from './theme/index';
import type { Theme, ThemeOverrides } from './theme/types';
import type { LayoutIR } from './ir/types';
import { copyToClipboard, toWechatClipboardPayload } from './platform/wechat';
import type { WechatPayload } from './platform/wechat';
import { toZhihuClipboardPayload } from './platform/zhihu';
import type { ZhihuOptions, ZhihuPayload } from './platform/zhihu';

/** wechatPayload 的输入：LayoutIR（内部先 applyTheme）或渲染态 DOM 容器 */
export type WechatInput = LayoutIR | HTMLElement;

function inputToContainer(
  input: WechatInput,
  theme: Theme | string | undefined,
  overrides: ThemeOverrides | undefined,
): { container: HTMLElement; attached: boolean } {
  if (Array.isArray(input)) {
    const container = applyTheme(input, resolveTheme(theme ?? 'modi'), overrides);
    // 渲染态快照内联需要可计算样式的挂载环境
    const doc = container.ownerDocument;
    doc.body?.appendChild(container);
    return { container, attached: true };
  }
  return { container: input, attached: false };
}

/**
 * 一站式：IR 或渲染态 DOM → 微信剪贴板 payload。
 * 传入 IR 时必须给 theme（缺省用第一套内置主题 modi）；传入 DOM 时 theme 忽略。
 */
export function wechatPayload(
  input: WechatInput,
  theme?: Theme | string,
  overrides?: ThemeOverrides,
): WechatPayload {
  const { container, attached } = inputToContainer(input, theme, overrides);
  try {
    return toWechatClipboardPayload(container);
  } finally {
    if (attached) container.remove();
  }
}

/** 一站式：IR 或渲染态 DOM → 复制到剪贴板（ClipboardItem 双写，降级 execCommand） */
export async function copyForWechat(
  input: WechatInput,
  theme?: Theme | string,
  overrides?: ThemeOverrides,
): Promise<WechatPayload> {
  const payload = wechatPayload(input, theme, overrides);
  await copyToClipboard(payload);
  return payload;
}

/** zhihuPayload 的输入：LayoutIR（内部先 applyTheme）或渲染态 DOM 容器 */
export type ZhihuInput = LayoutIR | HTMLElement;

/**
 * 一站式：IR 或渲染态 DOM → 知乎剪贴板 payload（§3.2 降级渲染器）。
 * 传入 IR 时缺省用第一套 platform=zhihu 的内置主题（学术）；传入 DOM 时 theme 忽略。
 * 表格快照异步，故整体 async；opts.captureTable 可注入/置 null 强制文本退化。
 */
export async function zhihuPayload(
  input: ZhihuInput,
  theme?: Theme | string,
  overrides?: ThemeOverrides,
  opts?: ZhihuOptions,
): Promise<ZhihuPayload> {
  const { container, attached } = inputToContainer(input, theme ?? defaultThemeFor('zhihu'), overrides);
  try {
    return await toZhihuClipboardPayload(container, opts);
  } finally {
    if (attached) container.remove();
  }
}

/** 一站式：IR 或渲染态 DOM → 复制到剪贴板（ClipboardItem 双写，与微信同规格） */
export async function copyForZhihu(
  input: ZhihuInput,
  theme?: Theme | string,
  overrides?: ThemeOverrides,
  opts?: ZhihuOptions,
): Promise<ZhihuPayload> {
  const payload = await zhihuPayload(input, theme, overrides, opts);
  await copyToClipboard(payload);
  return payload;
}
