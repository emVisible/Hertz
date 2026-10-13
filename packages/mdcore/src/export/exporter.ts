/**
 * 导出器（§2 export/）：渲染态 DOM → PNG Blob / 多页 ZIP。
 *  - 主引擎 snapdom（@zumer/snapdom），兜底 modern-screenshot
 *  - 就绪闸门：document.fonts.ready + 容器内 img 全部 complete + 双 rAF
 *    +（浏览器端）像素 checksum 两帧一致；jsdom 下 API 缺失可注入/可跳过
 *  - 缩放降级 2×→1.5→1：捕获 canvas 尺寸超限错误自动降档重试，返回实际 scale
 *  - 长图（renderLongImage）：见 export/longimage.ts（≤8192px 切片渲染再拼总 canvas）
 */

/** 截图引擎：元素 → PNG Blob；尺寸超限必须抛错（isCanvasTooLargeError 判定） */
export interface CaptureEngine {
  capture(el: HTMLElement, scale: number): Promise<Blob>;
}

/** 就绪闸门：捕获前等待渲染稳定 */
export interface ReadyGate {
  waitReady(root: HTMLElement): Promise<void>;
}

/** 缩放降级阶梯 */
export const SCALE_LADDER = [2, 1.5, 1] as const;

/** canvas 尺寸超限错误判定（16384px / 1.2 亿像素双上限触发的各类报错） */
export function isCanvasTooLargeError(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  return /too large|exceeds|maximum|canvas|out of memory/i.test(msg);
}

/** 默认引擎：snapdom 主，非尺寸错误时兜底 modern-screenshot */
export function createDefaultCapture(): CaptureEngine {
  return {
    async capture(el, scale) {
      try {
        const { snapdom } = await import('@zumer/snapdom');
        return await snapdom.toBlob(el, { scale, type: 'png' });
      } catch (e) {
        if (isCanvasTooLargeError(e)) throw e; // 尺寸超限交给降级链，不切引擎
        const { domToBlob } = await import('modern-screenshot');
        return await domToBlob(el, { scale, type: 'image/png' });
      }
    },
  };
}

function nextFrame(doc: Document): () => Promise<void> {
  const win = doc.defaultView;
  if (win && typeof win.requestAnimationFrame === 'function') {
    return () => new Promise<void>((resolve) => win.requestAnimationFrame(() => resolve()));
  }
  // jsdom 无 rAF：退化为宏任务
  return () => new Promise<void>((resolve) => setTimeout(resolve, 16));
}

function canUseCanvas2d(doc: Document): boolean {
  try {
    return !!doc.createElement('canvas').getContext('2d');
  } catch {
    return false;
  }
}

async function blobChecksum(blob: Blob): Promise<number> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let h = 0x811c9dc5;
  for (let i = 0; i < buf.length; i += 64) {
    h ^= buf[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= buf.length;
  return h >>> 0;
}

/**
 * 浏览器端默认闸门：fonts.ready + 图片 complete + 双 rAF + 像素 checksum 两帧一致。
 * checksum 需要 canvas 2d 与 probe 引擎；jsdom 缺 API 时自动跳过。
 */
export function createBrowserReadyGate(probe?: CaptureEngine): ReadyGate {
  return {
    async waitReady(root) {
      const doc = root.ownerDocument;
      if (doc.fonts?.ready) {
        try {
          await doc.fonts.ready;
        } catch {
          /* 字体加载失败不阻塞导出 */
        }
      }
      const imgs = Array.from(root.querySelectorAll('img'));
      await Promise.all(
        imgs.map((img) => {
          if (img.complete) return Promise.resolve();
          return new Promise<void>((resolve) => {
            img.addEventListener('load', () => resolve(), { once: true });
            img.addEventListener('error', () => resolve(), { once: true });
          });
        }),
      );
      const raf = nextFrame(doc);
      await raf();
      await raf();
      // 像素 checksum 两帧一致（仅真实浏览器；jsdom 无 canvas 2d 自动跳过）
      if (probe && canUseCanvas2d(doc)) {
        try {
          const a = blobChecksum(await probe.capture(root, 0.25));
          await raf();
          const b = blobChecksum(await probe.capture(root, 0.25));
          if ((await a) !== (await b)) await raf();
        } catch {
          /* checksum 探测失败不阻塞导出 */
        }
      }
    },
  };
}

export interface ExportOptions {
  /** 起始倍率，默认 2；超限沿 SCALE_LADDER 降档 */
  scale?: number;
  /** 默认 createDefaultCapture()；测试注入 mock，不打真 canvas */
  capture?: CaptureEngine;
  /** 默认 createBrowserReadyGate(capture)；传 null 跳过闸门 */
  gate?: ReadyGate | null;
  /** 自定义超限判定 */
  isTooLarge?: (e: unknown) => boolean;
  /** zip 内文件名前缀，默认 'card' */
  filePrefix?: string;
}

export interface ExportCardsResult {
  blobs: Blob[];
  /** 实际出图倍率（可能因超限降级） */
  scale: number;
}

/** 渲染态页 DOM 组 → 每页一个 PNG Blob（含实际 scale） */
export async function exportCardsDetailed(
  pages: HTMLElement[],
  opts: ExportOptions = {},
): Promise<ExportCardsResult> {
  const capture = opts.capture ?? createDefaultCapture();
  const gate = opts.gate === undefined ? createBrowserReadyGate(capture) : opts.gate;
  const tooLarge = opts.isTooLarge ?? isCanvasTooLargeError;
  const ladder = SCALE_LADDER.filter((s) => s <= (opts.scale ?? 2));
  if (!ladder.length) ladder.push(1);

  for (let li = 0; li < ladder.length; li++) {
    const scale = ladder[li];
    try {
      const blobs: Blob[] = [];
      for (const page of pages) {
        if (gate) await gate.waitReady(page);
        blobs.push(await capture.capture(page, scale));
      }
      return { blobs, scale };
    } catch (e) {
      if (tooLarge(e) && li < ladder.length - 1) continue; // 降档重试
      throw e;
    }
  }
  throw new Error('@hertz/mdcore: exportCards 降级链耗尽');
}

/** 渲染态页 DOM 组 → 每页一个 PNG Blob */
export async function exportCards(pages: HTMLElement[], opts: ExportOptions = {}): Promise<Blob[]> {
  return (await exportCardsDetailed(pages, opts)).blobs;
}

/** 渲染态页 DOM 组 → 多页 PNG 打包 ZIP（jszip） */
export async function exportZip(pages: HTMLElement[], opts: ExportOptions = {}): Promise<Blob> {
  const { blobs } = await exportCardsDetailed(pages, opts);
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  const prefix = opts.filePrefix ?? 'card';
  blobs.forEach((blob, i) => {
    zip.file(`${prefix}-${String(i + 1).padStart(2, '0')}.png`, blob);
  });
  const u8 = await zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
  return new Blob([u8 as unknown as ArrayBuffer], { type: 'application/zip' });
}
