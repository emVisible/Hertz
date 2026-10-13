/**
 * 长图导出（§2）：渲染态容器 → 单张长图 PNG Blob。
 *  - 容器按 ≤8192px（CSS px）切成若干切片：每片包一层固定高度的裁剪壳
 *    （overflow:hidden + clone translateY(-offset)），逐片 capture，
 *    再按序 drawImage 拼到一张总 canvas。
 *  - 切片边界与行内元素：跨片盒的装饰（背景/边框/圆角）靠
 *    `box-decoration-break: clone` 在每个片段完整克隆，而不是在裁剪边硬切；
 *    WebKit 需 -webkit- 前缀。该属性逐元素下发到克隆子树。
 *  - 双上限：单轴 16384px / 总面积 1.2 亿像素。总面积超限做降档预检；
 *    单轴等引擎侧超限由 capture 抛错（isCanvasTooLargeError）驱动 SCALE_LADDER 降级。
 *  - 字体/图片/跨域就绪复用 ReadyGate（整根容器捕获前闸一次）。
 *  - SliceCaptureEngine/ReadyGate/总画布工厂均可注入：jsdom 测试全程 mock，
 *    不打真 canvas。
 */
import {
  createBrowserReadyGate,
  isCanvasTooLargeError,
  SCALE_LADDER,
} from './exporter';
import type { ExportOptions } from './exporter';

/** 单片最大高度（CSS px，§2 切片上限） */
export const LONG_IMAGE_SLICE_HEIGHT = 8192;
/** canvas 单轴上限（px） */
export const LONG_IMAGE_MAX_DIM = 16384;
/** canvas 总面积上限（1.2 亿像素） */
export const LONG_IMAGE_MAX_AREA = 120_000_000;

/** 2d 上下文鸭子类型：拼接只需要 drawImage */
export interface Context2dLike {
  drawImage(image: CanvasLike, dx: number, dy: number): void;
}

/** 可绘制画布（浏览器 HTMLCanvasElement / 测试 mock） */
export interface CanvasLike {
  width: number;
  height: number;
  getContext(contextId: '2d'): Context2dLike | null;
}

/** 切片捕获引擎：切片壳元素 → canvas 可绘制源（尺寸超限必须抛错） */
export interface SliceCaptureEngine {
  capture(el: HTMLElement, scale: number): Promise<CanvasLike>;
}

export interface LongImageOptions extends ExportOptions {
  /** 单片最大 CSS 高度，默认 8192 */
  sliceHeight?: number;
  /** 切片引擎，缺省 createDefaultSliceCapture()（snapdom 主，modern-screenshot 兜底） */
  sliceCapture?: SliceCaptureEngine;
  /** 总画布工厂，缺省 document.createElement('canvas')；jsdom 必须注入 mock */
  createCanvas?: (width: number, height: number) => CanvasLike;
  /** 总画布 → PNG Blob，缺省 canvas.toBlob；jsdom 必须注入 mock */
  canvasToBlob?: (canvas: CanvasLike) => Promise<Blob>;
}

export interface LongImageResult {
  blob: Blob;
  /** 实际出图倍率（可能因超限降级） */
  scale: number;
  /** 实际切片数 */
  slices: number;
}

/** 默认切片引擎：snapdom.toCanvas 主，非尺寸错误时兜底 modern-screenshot.domToCanvas */
export function createDefaultSliceCapture(): SliceCaptureEngine {
  return {
    async capture(el, scale) {
      try {
        const { snapdom } = await import('@zumer/snapdom');
        return (await snapdom.toCanvas(el, { scale })) as unknown as CanvasLike;
      } catch (e) {
        if (isCanvasTooLargeError(e)) throw e; // 尺寸超限交给降级链，不切引擎
        const { domToCanvas } = await import('modern-screenshot');
        return (await domToCanvas(el, { scale })) as unknown as CanvasLike;
      }
    },
  };
}

function defaultCreateCanvas(doc: Document): (width: number, height: number) => CanvasLike {
  return (width, height) => {
    const canvas = doc.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas as unknown as CanvasLike;
  };
}

async function defaultCanvasToBlob(canvas: CanvasLike): Promise<Blob> {
  const el = canvas as unknown as HTMLCanvasElement;
  return new Promise<Blob>((resolve, reject) => {
    el.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('@hertz/mdcore: canvas.toBlob 返回 null'))),
      'image/png',
    );
  });
}

/**
 * 构造第 i 片的裁剪壳：固定高度 + overflow:hidden，克隆体 translateY(-offset)
 * 把 [offsetY, offsetY+height) 区间对齐到壳口。壳挂到源容器旁（同源字体/相对单位），
 * 捕获后由调用方摘除。
 */
function makeSlice(source: HTMLElement, offsetY: number, height: number, width: number): HTMLElement {
  const doc = source.ownerDocument;
  const wrapper = doc.createElement('div');
  wrapper.style.setProperty('width', `${width}px`);
  wrapper.style.setProperty('height', `${height}px`);
  wrapper.style.setProperty('overflow', 'hidden');
  wrapper.style.setProperty('position', 'relative');

  const clone = source.cloneNode(true) as HTMLElement;
  clone.style.setProperty('margin', '0');
  clone.style.setProperty('width', `${width}px`);
  clone.style.setProperty('transform', `translateY(${-offsetY}px)`);
  // 切片边界不硬切行内/块盒装饰：box-decoration-break: clone 让跨片盒的
  // 背景、边框、圆角、padding 在断口两侧的片段上各自完整克隆（WebKit 需前缀），
  // 而不是在 8192px 裁剪边上把装饰削掉一半。逐元素下发到克隆子树。
  const all = [clone, ...Array.from(clone.querySelectorAll('*'))];
  for (const el of all) {
    const htmlEl = el as HTMLElement;
    htmlEl.style?.setProperty('box-decoration-break', 'clone');
    htmlEl.style?.setProperty('-webkit-box-decoration-break', 'clone');
  }
  wrapper.appendChild(clone);
  return wrapper;
}

/**
 * 渲染态容器 → 单张长图 PNG Blob（含实际 scale 与切片数）。
 * 切片坐标系为 CSS px；capture/拼接坐标统一乘 scale 进导出像素系。
 */
export async function renderLongImageDetailed(
  el: HTMLElement,
  opts: LongImageOptions = {},
): Promise<LongImageResult> {
  const sliceCapture = opts.sliceCapture ?? createDefaultSliceCapture();
  const gate = opts.gate === undefined ? createBrowserReadyGate(opts.capture) : opts.gate;
  const tooLarge = opts.isTooLarge ?? isCanvasTooLargeError;
  const ladder = SCALE_LADDER.filter((s) => s <= (opts.scale ?? 2));
  if (!ladder.length) ladder.push(1);
  const sliceHeight = opts.sliceHeight ?? LONG_IMAGE_SLICE_HEIGHT;
  const createCanvas = opts.createCanvas ?? defaultCreateCanvas(el.ownerDocument);
  const canvasToBlob = opts.canvasToBlob ?? defaultCanvasToBlob;

  const rect = el.getBoundingClientRect();
  const width = rect.width;
  const height = rect.height;
  if (!(width > 0) || !(height > 0)) {
    throw new Error('@hertz/mdcore: renderLongImage 容器尺寸为 0（需已挂载的渲染态 DOM）');
  }

  // 字体/图片/跨域就绪闸门：整根容器闸一次，切片共享同一渲染态
  if (gate) await gate.waitReady(el);

  const sliceCount = Math.ceil(height / sliceHeight);
  let skipped = 0;
  for (let li = 0; li < ladder.length; li++) {
    const scale = ladder[li];
    // 总面积降档预检：w·h·s² 超 1.2 亿像素直接降档，不必等引擎抛错
    if (width * height * scale * scale > LONG_IMAGE_MAX_AREA) {
      skipped += 1;
      continue;
    }
    const total = createCanvas(Math.round(width * scale), Math.round(height * scale));
    const ctx = total.getContext('2d');
    if (!ctx) throw new Error('@hertz/mdcore: 无法创建总画布 2d 上下文');

    const mounted: HTMLElement[] = [];
    try {
      for (let i = 0; i < sliceCount; i++) {
        const offsetY = i * sliceHeight;
        const h = Math.min(sliceHeight, height - offsetY);
        const sliceEl = makeSlice(el, offsetY, h, width);
        // 挂到源容器旁，保证克隆体解析到同一文档的字体与相对单位
        (el.parentElement ?? el.ownerDocument.body)?.appendChild(sliceEl);
        mounted.push(sliceEl);
        const sliceCanvas = await sliceCapture.capture(sliceEl, scale);
        // 按序拼接：第 i 片落在总画布 (0, offsetY·scale)
        ctx.drawImage(sliceCanvas, 0, Math.round(offsetY * scale));
      }
      return { blob: await canvasToBlob(total), scale, slices: sliceCount };
    } catch (e) {
      if (tooLarge(e) && li < ladder.length - 1) continue; // 引擎侧超限 → 降档重试
      throw e;
    } finally {
      for (const m of mounted) m.remove();
    }
  }
  throw new Error(
    `@hertz/mdcore: renderLongImage 超出单张长图上限（${LONG_IMAGE_MAX_DIM}px / 1.2 亿像素），请改用分页导出` +
      (skipped ? `（预检跳过 ${skipped} 档）` : ''),
  );
}

/** 渲染态容器 → 单张长图 PNG Blob */
export async function renderLongImage(el: HTMLElement, opts: LongImageOptions = {}): Promise<Blob> {
  return (await renderLongImageDetailed(el, opts)).blob;
}
