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
export { LANG_ALIASES, normalizeLang, parseFenceInfo } from './parse/lang';
export type { FenceInfo } from './parse/lang';
export {
  cardTexture,
  DECO_IDS,
  decoPreset,
  DECO_PRESETS,
  TEXTURE_IDS,
  TEXTURE_LABELS,
} from './platform/decks';
export type { CardTexture, DecoPreset, TextureId } from './platform/decks';
export {
  CALLOUT_TITLES,
  convertInline,
  headingAnchor,
  inlinePlain,
  parseImageSizeSpec,
  parseToIR,
  parseToIRDetailed,
  tokensToIR,
} from './ir/parseToIR';
export type {
  IRBlock,
  IRBlockType,
  IRDiagnostic,
  InlineNode,
  LayoutIR,
  LineRange,
} from './ir/types';
export { applyTheme, cjkNumeral, resolveThemedProps } from './theme/apply';
export type { ApplyOptions } from './theme/apply';
export { deriveTheme, derivedSlots, mergeSlots, resolveThemeSlots, themeWithOverrides } from './theme/derive';
export {
  CODE_BARS,
  CODE_THEMES,
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
  CodeThemeId,
  HeadingStyle,
  HrStyle,
  ListStyle,
  QuoteStyle,
  ResolvedTokens,
  StrongStyle,
  TableStyle,
} from './theme/types';
// P1-3 / P1-5：Shiki 二次 pass + 代码高亮预设
export {
  CODE_LANG_ATTR,
  codeThemeNameFor,
  highlightCodeBlocks,
  resolveCodeThemeName,
  setCodeHighlighter,
  shikiLangOf,
} from './theme/shiki';
export type { CodeHighlighter, HighlightCodeOptions } from './theme/shiki';
// P2-4：Mermaid 预渲染（必须在分页之前）
export { mermaidBlocksOf, rasterizeMermaid, renderMermaidCache } from './theme/mermaid';
export type { MermaidOptions, MermaidRenderer, MermaidResult, SvgCapture } from './theme/mermaid';
export { mermaidKeyOf } from './theme/mermaidKey';
// P2-2：主题导出独立 CSS
export { themeToCss } from './theme/css';
export type { ThemeCssOptions } from './theme/css';
export { hljsDark, hljsLight } from './theme/themes/base';
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
  CUSTOM_THEME_PREFIX,
  clearCustomThemes,
  isBuiltinTheme,
  listCustomThemes,
  registerTheme,
  unregisterTheme,
} from './theme/index';
export type { StyleProps, Theme, ThemeOverrides, ThemePlatform, ThemeTokens } from './theme/types';
export { copyToClipboard, toWechatClipboardPayload, WECHAT_FOOTNOTE } from './platform/wechat';
export type { WechatPayload } from './platform/wechat';
export { toZhihuClipboardPayload } from './platform/zhihu';
export type { TableCapture, ZhihuOptions, ZhihuPayload } from './platform/zhihu';
export { panguSpacing, panguSpacingDOM } from './platform/pangu'
// 切片 E：内容合规（违禁词扫描）
export { BUILT_IN, GENERAL_LISTS, METAPHYSICS_LIST, type ComplianceWord } from './compliance/wordlists'
export { scanCompliance, SEPARATOR } from './compliance/scan'
export type { ComplianceFinding, ComplianceCategory, ComplianceResult, ComplianceLabels } from './compliance/types';
// 切片 B：分页引擎（测量可注入）
export { domMeasurer, paginate } from './paginate/paginate';
export type { Measurer, PagePadding, PageSpec, PaginateOptions } from './paginate/paginate';
export { adjustBreak, codeBreak, NO_END, NO_START } from './paginate/breaks';
// 切片 B：小红书适配
export {
  XHS_CARD,
  XHS_MAX_PAGES,
  XHS_RATIO_KEYS,
  XHS_RATIOS,
  xhsCardSize,
  xhsCaption,
  xhsCards,
} from './platform/xhs';
export type { XhsRatio } from './platform/xhs';
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
  waitForImages,
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
// P2-5：PDF 导出（分页页壳 → 每页一张图 → A4）
export { exportPdf, PDF_PAGE } from './export/pdf';
export type {
  PdfDocumentFactory,
  PdfDocumentLike,
  PdfExportOptions,
  PdfExportResult,
} from './export/pdf';

import { applyTheme } from './theme/apply';
import { defaultThemeFor, resolveTheme } from './theme/index';
import { codeThemeNameFor, highlightCodeBlocks } from './theme/shiki';
import { rasterizeMermaid, renderMermaidCache } from './theme/mermaid';
import type { Theme, ThemeOverrides } from './theme/types';
import type { LayoutIR } from './ir/types';
import { copyToClipboard, toWechatClipboardPayload } from './platform/wechat';
import type { WechatPayload } from './platform/wechat';
import { toZhihuClipboardPayload } from './platform/zhihu';
import type { ZhihuOptions, ZhihuPayload } from './platform/zhihu';

/** wechatPayload 的输入：LayoutIR（内部先 applyTheme）或渲染态 DOM 容器 */
export type WechatInput = LayoutIR | HTMLElement;

/** 深浅判定：Mermaid 的配色与 Shiki 主题名都跟着主题自身的 `dark` 标记走 */
function isDarkTheme(theme: Theme | string | undefined): boolean {
  if (!theme) return false;
  return !!resolveTheme(theme).dark;
}

/**
 * 异步富集：渲染态 DOM → 真正可粘贴的 DOM（P1-3 Shiki + P2-4 Mermaid）。
 *
 * 为什么必须在 payload 之前做这两件事：
 * - **Shiki**：二次 pass 产出的内联色是产物的一部分，晚一步复制出去的就是 hljs 版；
 * - **Mermaid**：微信/知乎清洗器剥 SVG，必须先栅格化成 `<img>`，否则用户粘出来
 *   是一段空白（而这正是"结构层全绿、产物里却不成立"的典型）。
 *
 * 同步的 `wechatPayload()` 不走这条路（它没有 await 的余地）；它的用途是
 * 结构层测试与"调用方自己已经富集过"的场景。产品路径一律用 `copyForWechat`。
 */
async function enrichForClipboard(
  container: HTMLElement,
  theme: Theme | string | undefined,
  overrides: ThemeOverrides,
): Promise<void> {
  await highlightCodeBlocks(container, {
    themeName: codeThemeNameFor(theme ?? 'modi', overrides),
  });
  await rasterizeMermaid(container);
}

/**
 * IR → 已挂载的渲染态 DOM（含 Mermaid 预渲染）。
 *
 * Mermaid 必须**先渲染再 applyTheme**：分页/渲染都是同步量高度的，
 * 而 mermaid.render 是异步的，顺序反了就是"按源码高度排版、图一落地就溢出"。
 */
async function buildContainer(
  ir: LayoutIR,
  theme: Theme | string | undefined,
  overrides: ThemeOverrides,
  dark: boolean,
): Promise<HTMLElement> {
  const { cache } = await renderMermaidCache(ir, { dark });
  const container = applyTheme(
    ir,
    resolveTheme(theme ?? 'modi'),
    overrides,
    globalThis.document,
    undefined,
    { mermaid: cache.size ? cache : undefined },
  );
  container.ownerDocument.body?.appendChild(container);
  return container;
}

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
 *
 * ⚠️ 同步入口：**不做** Shiki 二次 pass 与 Mermaid 栅格化（没有 await 的余地）。
 * 产品路径用 `copyForWechat`；这里供结构层测试与已富集的 DOM 使用。
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

/** 一站式：IR 或渲染态 DOM → 复制到剪贴板（ClipboardItem 双写，降级 execCommand）。
 *
 *  产品路径的**唯一入口**：先 Shiki 二次 pass、Mermaid 栅格化，再进清洗器。 */
export async function copyForWechat(
  input: WechatInput,
  theme?: Theme | string,
  overrides?: ThemeOverrides,
): Promise<WechatPayload> {
  let payload: WechatPayload;
  if (Array.isArray(input)) {
    const container = await buildContainer(input, theme, overrides ?? {}, isDarkTheme(theme));
    try {
      await enrichForClipboard(container, theme, overrides ?? {});
      payload = toWechatClipboardPayload(container);
    } finally {
      container.remove();
    }
  } else {
    await enrichForClipboard(input, theme, overrides ?? {});
    payload = wechatPayload(input);
  }
  // 两个分支**都**要写剪贴板。第一版把 write 留在 DOM 分支、IR 分支直接 return，
  // 于是"复制到公众号"按钮静默失效——而这条路的结构断言照样全绿
  // （payload 确实生成了，只是没人写进剪贴板）。判据见 copyForWechat.test.ts。
  await copyToClipboard(payload);
  return payload;
}

/** zhihuPayload 的输入：LayoutIR（内部先 applyTheme）或渲染态 DOM 容器 */
export type ZhihuInput = LayoutIR | HTMLElement;

/**
 * 一站式：IR 或渲染态 DOM → 知乎剪贴板 payload（§3.2 降级渲染器）。
 * 传入 IR 时缺省用第一套 platform=zhihu 的内置主题（学术）；传入 DOM 时 theme 忽略。
 * 表格快照异步，故整体 async；opts.captureTable 可注入/置 null 强制文本退化。
 *
 * 与微信同规格：Mermaid 预渲染（IR 输入时）+ Shiki 二次 pass + SVG 栅格化。
 */
export async function zhihuPayload(
  input: ZhihuInput,
  theme?: Theme | string,
  overrides?: ThemeOverrides,
  opts?: ZhihuOptions,
): Promise<ZhihuPayload> {
  const t = theme ?? defaultThemeFor('zhihu');
  const ov = overrides ?? {};
  let container: HTMLElement;
  let attached = false;
  if (Array.isArray(input)) {
    container = await buildContainer(input, t, ov, isDarkTheme(t));
    attached = true;
  } else {
    container = input;
  }
  try {
    await enrichForClipboard(container, t, ov);
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
