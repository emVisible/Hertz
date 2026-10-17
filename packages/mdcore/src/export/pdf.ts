/**
 * PDF 导出（P2-5 / v0.37）：渲染态页 DOM 组 → 单个 PDF Blob。
 *
 * ## 为什么不是"把长图塞进 PDF"
 *
 * 长图是**单张**超过 8192px 高的位图，再高就撞 canvas 上限（1.2 亿像素）而拒绝
 * 导出。把长图塞进 PDF 等于继承那个上限，而且长图只有一种宽度、没有分页。
 * 所以 PDF 走**分页**路线：`paginate()` 量出来的页壳本身就是 A4 比例，
 * 一页 PNG 对一页 PDF，页数天然守恒。
 *
 * ## 页数守恒（验收判据）
 *
 * PDF 的页数必须等于送进来的页数组长度：少一页就是丢内容，多一页是空页。
 * 降档重试（SCALE_LADDER）可能改变倍率但**不改变页数**——每页都要落成一张图。
 *
 * ## 引擎与依赖
 *
 * jsPDF 动态 import（与 jszip/snapdom 同纪律），并且**可注入**：
 * jsdom 里没有 canvas，用注入的 `createPdf` 替身即可断言页数/图片数；
 * 真浏览器里用 jsPDF 出货。
 */
import { exportCardsDetailed } from './exporter';
import type { ExportOptions } from './exporter';

/** PDF 页尺寸：A4 纵向，单位 pt（1pt = 1/72 inch），与 690×976 的页壳同比例 */
export const PDF_PAGE = { width: 595.28, height: 841.89 } as const;

/** jsPDF 最小接口：只依赖这三个方法，便于 jsdom 注入替身 */
export interface PdfDocumentLike {
  addPage(): void;
  addImage(dataUrl: string, format: string, x: number, y: number, w: number, h: number): void;
  output(type: 'blob'): Blob;
}

/** PDF 组装器工厂：缺省动态 import('jspdf')；测试注入替身 */
export type PdfDocumentFactory = () => Promise<PdfDocumentLike>;

export interface PdfExportOptions extends ExportOptions {
  /** PDF 组装器工厂，缺省 jspdf */
  createPdf?: PdfDocumentFactory;
  /** 导出文件名（写进 Blob 的元数据，无则名 <title>.pdf 由调用方给） */
  fileName?: string;
}

export interface PdfExportResult {
  blob: Blob;
  /** 实际 PDF 页数（判据：=== pages.length） */
  pageCount: number;
  /** 实际出图倍率（可能因超限降级） */
  scale: number;
}

async function defaultCreatePdf(): Promise<PdfDocumentLike> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'pt', format: 'a4', orientation: 'portrait', compress: true });
  return doc as unknown as PdfDocumentLike;
}

/** Blob → dataURL（jsPDF 的 addImage 只收字符串或 canvas，不收 Blob） */
async function blobToDataUrl(blob: Blob): Promise<string> {
  // canvas.toDataURL 的真图在 jsdom 里拿不到；FileReader 在两端都可用
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(blob);
  });
}

/**
 * 渲染态页 DOM 组 → 单个 PDF（每页一张图，铺满 A4）。
 *
 * 复用 `exportCardsDetailed` 的就绪闸门 + 降档链：字体没就绪 / 图片没解码的
 * 截图进了 PDF，就是一张空白页在文件里，用户在阅读器里才发现。
 */
export async function exportPdf(
  pages: HTMLElement[],
  opts: PdfExportOptions = {},
): Promise<PdfExportResult> {
  if (!pages.length) {
    throw new Error('@hertz/mdcore: exportPdf 需要至少一页（稿子是空的？）');
  }
  const { blobs, scale } = await exportCardsDetailed(pages, opts);
  const createPdf = opts.createPdf ?? defaultCreatePdf;
  const doc = await createPdf();
  const mime = blobs[0]?.type || 'image/png';
  const format = mime.includes('jpeg') ? 'JPEG' : 'PNG';

  /**
   * 每页一图，`addPage()` 从**第 2 页起**才调。
   *
   * jsPDF 实例天生就带第 1 页，无条件先 addPage 会在最前面多出一张空白页——
   * 页数不守恒，而且是用户打开文件第一眼就看见的那种错。
   */
  for (let i = 0; i < blobs.length; i += 1) {
    if (i > 0) doc.addPage();
    const dataUrl = await blobToDataUrl(blobs[i]);
    doc.addImage(dataUrl, format, 0, 0, PDF_PAGE.width, PDF_PAGE.height);
  }
  return { blob: doc.output('blob'), pageCount: blobs.length, scale };
}