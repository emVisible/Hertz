import { describe, expect, it } from 'vitest';
import {
  LONG_IMAGE_SLICE_HEIGHT,
  renderLongImage,
  renderLongImageDetailed,
} from '../index';
import type { CanvasLike, ReadyGate, SliceCaptureEngine } from '../index';

/**
 * 长图导出测试（§2/§7）：mock 切片引擎返回假 canvas（width/height + getContext），
 * 不打真 canvas；断言切片数量、按序拼接坐标、降级链、单片 8192 上限。
 */

const SLICE = LONG_IMAGE_SLICE_HEIGHT; // 8192

interface DrawCall {
  x: number;
  y: number;
  sliceWidth: number;
  sliceHeight: number;
}

interface FakeCanvas extends CanvasLike {
  draws: DrawCall[];
}

function fakeCanvas(width: number, height: number): FakeCanvas {
  const draws: DrawCall[] = [];
  return {
    width,
    height,
    draws,
    getContext: () => ({
      drawImage: (img: CanvasLike, dx: number, dy: number) => {
        draws.push({ x: dx, y: dy, sliceWidth: img.width, sliceHeight: img.height });
      },
    }),
  };
}

/** 合成渲染态容器：jsdom 下 getBoundingClientRect 返回 0，mock 成指定尺寸 */
function tallContainer(width: number, height: number): HTMLElement {
  const el = document.createElement('section');
  el.textContent = 'long article';
  el.getBoundingClientRect = () =>
    ({
      width,
      height,
      top: 0,
      left: 0,
      right: width,
      bottom: height,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  return el;
}

interface CaptureRecord {
  scales: number[];
  sliceHeights: number[];
}

/** mock 切片引擎：按切片壳的 style.height 返回等比假 canvas */
function mockSliceCapture(record: CaptureRecord, failAt?: (scale: number) => boolean): SliceCaptureEngine {
  return {
    async capture(el, scale) {
      record.scales.push(scale);
      const h = parseFloat(el.style.height || '0');
      record.sliceHeights.push(h);
      if (failAt?.(scale)) throw new Error('Canvas size exceeds the maximum allowed size');
      return fakeCanvas(Math.round(800 * scale), Math.round(h * scale));
    },
  };
}

const noopGate: ReadyGate = { waitReady: async () => {} };

function harness(record: CaptureRecord, failAt?: (scale: number) => boolean) {
  const total = { current: fakeCanvas(0, 0) };
  return {
    sliceCapture: mockSliceCapture(record, failAt),
    createCanvas: (w: number, h: number) => {
      total.current = fakeCanvas(w, h);
      return total.current;
    },
    canvasToBlob: async () => new Blob(['fake-long-png'], { type: 'image/png' }),
    total,
  };
}

describe('renderLongImage：切片与拼接', () => {
  it('30000px 高容器 → 4 片 capture，按序 drawImage 拼接', async () => {
    const record: CaptureRecord = { scales: [], sliceHeights: [] };
    const h = harness(record);
    const result = await renderLongImageDetailed(tallContainer(800, 30000), {
      ...h,
      gate: noopGate,
      scale: 1,
    });
    expect(result.slices).toBe(4);
    expect(record.scales).toEqual([1, 1, 1, 1]);
    // 切片高度：8192 × 3 + 余量 5440
    expect(record.sliceHeights).toEqual([SLICE, SLICE, SLICE, 30000 - SLICE * 3]);
    // 按序拼接到总画布：(0,0) (0,8192) (0,16384) (0,24576)
    expect(h.total.current.draws.map((d) => [d.x, d.y])).toEqual([
      [0, 0],
      [0, SLICE],
      [0, SLICE * 2],
      [0, SLICE * 3],
    ]);
    // 拼接源高度与切片等比
    expect(h.total.current.draws.map((d) => d.sliceHeight)).toEqual([
      SLICE,
      SLICE,
      SLICE,
      30000 - SLICE * 3,
    ]);
    expect(result.blob.type).toBe('image/png');
  });

  it('单片高度永不超过 8192（9000px → 8192 + 808）', async () => {
    const record: CaptureRecord = { scales: [], sliceHeights: [] };
    const h = harness(record);
    const result = await renderLongImageDetailed(tallContainer(800, 9000), {
      ...h,
      gate: noopGate,
      scale: 1,
    });
    expect(result.slices).toBe(2);
    expect(record.sliceHeights).toEqual([SLICE, 9000 - SLICE]);
    for (const sh of record.sliceHeights) expect(sh).toBeLessThanOrEqual(SLICE);
  });

  it('不足一片（5000px）→ 单片直出', async () => {
    const record: CaptureRecord = { scales: [], sliceHeights: [] };
    const h = harness(record);
    const result = await renderLongImageDetailed(tallContainer(800, 5000), {
      ...h,
      gate: noopGate,
      scale: 1,
    });
    expect(result.slices).toBe(1);
    expect(record.sliceHeights).toEqual([5000]);
  });

  it('捕获前经过一次就绪闸门（字体/图片/跨域复用 ReadyGate）', async () => {
    const gated: HTMLElement[] = [];
    const gate: ReadyGate = {
      waitReady: async (root) => {
        gated.push(root);
      },
    };
    const record: CaptureRecord = { scales: [], sliceHeights: [] };
    const h = harness(record);
    const el = tallContainer(800, 5000);
    await renderLongImage(el, { ...h, gate, scale: 1 });
    expect(gated).toEqual([el]);
  });
});

describe('renderLongImage：缩放降级链', () => {
  it('capture 抛尺寸错误 → scale 2 降档 1.5 重试', async () => {
    const record: CaptureRecord = { scales: [], sliceHeights: [] };
    const h = harness(record, (s) => s === 2);
    const result = await renderLongImageDetailed(tallContainer(800, 3000), {
      ...h,
      gate: noopGate,
    });
    expect(result.scale).toBe(1.5);
    expect(record.scales).toEqual([2, 1.5]);
  });

  it('总面积超 1.2 亿像素 → 预检降档（2 跳过，1.5 成交）', async () => {
    const record: CaptureRecord = { scales: [], sliceHeights: [] };
    const h = harness(record);
    // 9000×4000：2× = 1.44 亿超限跳过；1.5× = 8100 万成交
    const result = await renderLongImageDetailed(tallContainer(9000, 4000), {
      ...h,
      gate: noopGate,
    });
    expect(result.scale).toBe(1.5);
    expect(record.scales[0]).toBe(1.5);
  });

  it('降级链耗尽（1× 仍超面积上限）→ 明确报错', async () => {
    const record: CaptureRecord = { scales: [], sliceHeights: [] };
    const h = harness(record);
    await expect(
      renderLongImageDetailed(tallContainer(12000, 10001), { ...h, gate: noopGate }),
    ).rejects.toThrow(/长图上限/);
    // 一次 capture 都不该发生
    expect(record.scales).toEqual([]);
  });

  it('非尺寸错误不降级，直接抛出', async () => {
    const record: CaptureRecord = { scales: [], sliceHeights: [] };
    const h = harness(record);
    const boom: SliceCaptureEngine = {
      async capture() {
        throw new Error('network fetch failed');
      },
    };
    await expect(
      renderLongImageDetailed(tallContainer(800, 3000), {
        ...h,
        sliceCapture: boom,
        gate: noopGate,
        scale: 1,
      }),
    ).rejects.toThrow('network fetch failed');
  });
});
