import { describe, expect, it } from 'vitest';
import { exportCards, exportCardsDetailed, exportZip } from '../index';
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
