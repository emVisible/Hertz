import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyToClipboard } from '../index';

/**
 * 剪贴板降级链（真浏览器实测：窗口失焦时 ClipboardItem 写会抛
 * "Document is not focused"，此时必须继续降级而不是放弃复制）。
 */

class FakeClipboardItem {
  static readonly itemTypes: string[] = [];
  constructor(items: Record<string, Blob>) {
    FakeClipboardItem.itemTypes.push(...Object.keys(items));
  }
}

function stubClipboard(opts: { writeFails?: boolean; hasWriteText?: boolean }) {
  const write = vi.fn(async () => {
    if (opts.writeFails) throw new Error('Document is not focused.');
  });
  const writeText = vi.fn(async () => {});
  const nav: Record<string, unknown> = {
    clipboard: {
      write,
      ...(opts.hasWriteText === false ? {} : { writeText }),
    },
  };
  vi.stubGlobal('navigator', nav);
  vi.stubGlobal('ClipboardItem', FakeClipboardItem);
  return { write, writeText };
}

afterEach(() => vi.unstubAllGlobals());

describe('copyToClipboard 降级链', () => {
  it('async 写入抛错（失焦）→ 继续降级到 writeText，不中断复制', async () => {
    const { write, writeText } = stubClipboard({ writeFails: true });
    await copyToClipboard({ html: '<p>x</p>', text: '正文' });
    expect(write).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('正文');
  });

  it('全链都失败 → 抛出原始原因（不吞成通用文案）', async () => {
    const { write } = stubClipboard({ writeFails: true, hasWriteText: false });
    // jsdom 无 execCommand，故降级链只剩 writeText；这里禁掉它 = 全链失败
    await expect(copyToClipboard({ html: '<p>x</p>', text: '正文' })).rejects.toThrow(
      /Document is not focused/,
    );
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('async 写入成功 → 不再触发降级', async () => {
    const { write, writeText } = stubClipboard({});
    await copyToClipboard({ html: '<p>x</p>', text: '正文' });
    expect(write).toHaveBeenCalledTimes(1);
    expect(writeText).not.toHaveBeenCalled();
  });
});
