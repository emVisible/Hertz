/**
 * PDF 导出的判据（P2-5）。
 *
 * 判据是计划里写明的两条：**字节头 `%PDF`** 与**页数守恒**。
 * 页数守恒是这里唯一真正有牙齿的一条：少一页丢内容、多一页是空页，
 * 而这两种错在结构层（页数组长度）与产物层（PDF 页数）之间正好差一次转换。
 *
 * 所以刻意分两腿：
 * - 注入 jsPDF 替身：验"每页一图一页面"的接线与降档行为（不打真 canvas）；
 * - 真 jsPDF：验字节头真的是 PDF（jsdom 里 addImage 用一张 1×1 PNG 就够）。
 */
import { describe, expect, it } from 'vitest';

import { exportPdf, paginate, parseToIR, PDF_PAGE } from '../index';
import type { PdfDocumentLike } from '../index';

/** 1×1 透明 PNG：jsPDF 需要一张真图才能算尺寸，纯文字它不认 */
const PX_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

interface FakePdf extends PdfDocumentLike {
  pages: number;
  images: Array<[string, number, number, number, number]>;
}

function fakeFactory(): { createPdf: () => Promise<FakePdf>; box: { last?: FakePdf } } {
  const box: { last?: FakePdf } = {};
  return {
    box,
    createPdf: async () => {
      // 仿 jsPDF：**实例天生就带第 1 页**。真 jsPDF 那条腿（%PDF 字节）会验证
      // 这个前提对不对；这里照抄，免得替身比真货宽松。
      const doc: FakePdf = {
        pages: 1,
        images: [],
        addPage() {
          doc.pages += 1;
        },
        addImage(dataUrl, _format, x, y, w, h) {
          doc.images.push([dataUrl, x, y, w, h]);
        },
        output() {
          return new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])], { type: 'application/pdf' });
        },
      };
      box.last = doc;
      return doc;
    },
  };
}

/** 三页固定高度的页壳（不依赖真实排版测量） */
function threePages(doc: Document): HTMLElement[] {
  return [1, 2, 3].map(() => {
    const el = doc.createElement('div');
    el.style.width = '100px';
    el.style.height = '100px';
    return el;
  });
}

const captureEngine = { capture: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }) };

describe('页数守恒', () => {
  it('每页一张图、图铺满 A4，页数 === 页数组长度', async () => {
    const { createPdf, box } = fakeFactory();
    const pages = threePages(document);
    const result = await exportPdf(pages, {
      capture: captureEngine,
      gate: null,
      createPdf,
      scale: 1,
    });
    expect(result.pageCount).toBe(pages.length);
    expect(box.last?.pages).toBe(3);
    expect(box.last?.images).toHaveLength(3);
    for (const [, x, y, w, h] of box.last?.images ?? []) {
      expect([x, y, w, h]).toEqual([0, 0, PDF_PAGE.width, PDF_PAGE.height]);
    }
  });

  it('空页数组直接报错（不给用户一个 0 页的 PDF）', async () => {
    await expect(exportPdf([], { capture: captureEngine, gate: null, createPdf: fakeFactory().createPdf })).rejects.toThrow(
      /至少一页/,
    );
  });

  it('降档重试不改变页数（SCALE_LADDER 只动倍率）', async () => {
    let round = 0;
    let pagesSeen = 0;
    const result = await exportPdf(threePages(document), {
      gate: null,
      createPdf: fakeFactory().createPdf,
      scale: 2,
      // 第一轮在第一页就抛"尺寸超限"，逼出降档重跑整组（exporter 的既有语义）
      capture: {
        capture: async () => {
          if (round === 0) {
            round = 1;
            throw new Error('canvas too large');
          }
          pagesSeen += 1;
          return new Blob([new Uint8Array([1])], { type: 'image/png' });
        },
      },
    });
    expect(round).toBe(1);
    expect(pagesSeen).toBe(3); // 降档后仍然是三页
    expect(result.pageCount).toBe(3);
    expect(result.scale).toBeLessThan(2);
  });
});

describe('产物字节', () => {
  it('真 jsPDF 出的字节以 %PDF 开头（判据原文）', async () => {
    const pages = [1].map(() => {
      const el = document.createElement('div');
      el.style.width = '200px';
      el.style.height = '300px';
      return el;
    });
    const result = await exportPdf(pages, {
      gate: null,
      scale: 1,
      capture: { capture: async () => blobFromDataUrl(PX_PNG) },
    });
    const head = new Uint8Array(await result.blob.slice(0, 4).arrayBuffer());
    expect(new TextDecoder().decode(head)).toBe('%PDF');
    expect(result.pageCount).toBe(1);
  });

  it('A4 纵向尺寸固定（595.28 × 841.89 pt）', () => {
    expect(PDF_PAGE.width).toBeCloseTo(595.28, 2);
    expect(PDF_PAGE.height).toBeCloseTo(841.89, 2);
  });
});

describe('与分页器的接缝', () => {
  it('页数组来自 paginate（页数由内容决定，不在本模块里造页）', () => {
    const pages = paginate(parseToIR('# 标题\n\n正文一\n\n正文二'), {
      theme: 'modi',
      page: { width: 690, height: 976, padding: 40 },
      measurer: { fits: () => true },
    });
    expect(pages.length).toBeGreaterThan(0);
    // 页壳是分页器的产物（`.mdcore-page`），PDF 模块只吃页数组、不自己造页
    for (const page of pages) {
      expect(page.className).toContain('mdcore-page');
    }
  });
});

/** dataURL → Blob（测试侧：把 1×1 PNG 交给 jsPDF） */
function blobFromDataUrl(dataUrl: string): Blob {
  const base64 = dataUrl.split(',')[1];
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: 'image/png' });
}