import { describe, expect, it } from 'vitest';
import { exportCards, exportCardsDetailed, exportZip, zipBlobs } from '../index';
import type { CaptureEngine, ReadyGate } from '../index';

/** 导出器测试（§7）：依赖注入 mock 引擎，不打真 canvas */

function makePages(n: number): HTMLElement[] {
  return Array.from({ length: n }, (_, i) => {
    const el = document.createElement('section');
    el.textContent = `page ${i + 1}`;
    return el;
  });
}

const noopGate: ReadyGate = { waitReady: async () => {} };

function pngBlob(label: string): Blob {
  return new Blob([`fake-png-${label}`], { type: 'image/png' });
}

describe('exportCards：缩放降级链', () => {
  it('canvas 尺寸超限 → scale 2 降档 1.5 重试，返回实际 scale', async () => {
    const calls: number[] = [];
    const capture: CaptureEngine = {
      async capture(_el, scale) {
        calls.push(scale);
        if (scale === 2) throw new Error('Canvas size exceeds the maximum allowed size');
        return pngBlob(`s${scale}`);
      },
    };
    const { blobs, scale } = await exportCardsDetailed(makePages(2), { capture, gate: noopGate });
    expect(scale).toBe(1.5);
    expect(blobs.length).toBe(2);
    // 第一次 2 失败 → 整轮降到 1.5 重试两页
    expect(calls).toEqual([2, 1.5, 1.5]);
  });

  it('2 与 1.5 都超限 → 降到 1', async () => {
    const calls: number[] = [];
    const capture: CaptureEngine = {
      async capture(_el, scale) {
        calls.push(scale);
        if (scale > 1) throw new Error('canvas area too large');
        return pngBlob('s1');
      },
    };
    const { scale } = await exportCardsDetailed(makePages(1), { capture, gate: noopGate });
    expect(scale).toBe(1);
    expect(calls).toEqual([2, 1.5, 1]);
  });

  it('非尺寸错误不降级，直接抛出', async () => {
    const capture: CaptureEngine = {
      async capture() {
        throw new Error('network fetch failed');
      },
    };
    await expect(exportCardsDetailed(makePages(1), { capture, gate: noopGate })).rejects.toThrow(
      'network fetch failed',
    );
  });

  it('exportCards 返回每页一个 PNG Blob，且每页捕获前经过就绪闸门', async () => {
    const gated: string[] = [];
    const gate: ReadyGate = {
      waitReady: async (root) => {
        gated.push(root.textContent ?? '');
      },
    };
    const capture: CaptureEngine = { capture: async (_el, scale) => pngBlob(`s${scale}`) };
    const blobs = await exportCards(makePages(3), { capture, gate });
    expect(blobs.length).toBe(3);
    for (const b of blobs) expect(b.type).toBe('image/png');
    expect(gated).toEqual(['page 1', 'page 2', 'page 3']);
  });
});

describe('exportZip', () => {
  it('产物是合法 zip（PK\\x03\\x04 头），含逐页 PNG', async () => {
    const capture: CaptureEngine = { capture: async (_el, scale) => pngBlob(`s${scale}`) };
    const zipBlob = await exportZip(makePages(2), { capture, gate: noopGate, filePrefix: 'xhs' });
    const buf = new Uint8Array(await zipBlob.arrayBuffer());
    expect(buf[0]).toBe(0x50); // P
    expect(buf[1]).toBe(0x4b); // K
    expect(buf[2]).toBe(0x03);
    expect(buf[3]).toBe(0x04);
  });
});

describe('zipBlobs：批量出图打成一个包', () => {
  it('命名条目全部落进同一个 ZIP，条目名原样保留（多篇稿各占一个子目录）', async () => {
    const JSZip = (await import('jszip')).default;
    const blob = await zipBlobs([
      { name: '甲/card-01.png', blob: pngBlob('a') },
      { name: '甲/card-02.png', blob: pngBlob('b') },
      { name: '乙/long.png', blob: pngBlob('c') },
    ]);
    const head = new Uint8Array(await blob.arrayBuffer()).slice(0, 4);
    expect([...head]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    // jszip 会为路径自动补目录条目（`甲/`），只关心文件条目
    const files = Object.keys(zip.files).filter((n) => !n.endsWith('/')).sort();
    expect(files).toEqual(['乙/long.png', '甲/card-01.png', '甲/card-02.png']);
    expect(await zip.file('甲/card-02.png')!.async('string')).toBe('fake-png-b');
  });
});

describe('exportCards：游离节点必须先渲染再截图', () => {
  it('capture 看到的页节点一定在文档内，出图后原样摘干净', async () => {
    const seen: boolean[] = [];
    const capture: CaptureEngine = {
      async capture(el) {
        seen.push(el.isConnected);
        return pngBlob('x');
      },
    };
    const pages = makePages(2);
    expect(pages[0].isConnected).toBe(false);
    await exportCardsDetailed(pages, { capture, gate: noopGate });
    // 真浏览器实测：游离节点喂给 snapdom 会静默产出 4×4 空图，故这里必须是 true
    expect(seen).toEqual([true, true]);
    expect(pages.every((p) => !p.isConnected)).toBe(true);
    expect(document.querySelector('[data-mdcore-offscreen]')).toBeNull();
  });
});
