import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyToClipboard } from '../index';
import { toWechatClipboardPayload } from './wechat';

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

describe('图片地址白名单（进剪贴板前的最后一道）', () => {
  /** 三类地址：http(s) 留；位图 data URL 留；其余换 1×1 占位 */
  function payloadFor(src: string): string {
    const el = document.createElement('section');
    const img = document.createElement('img');
    img.setAttribute('src', src);
    img.setAttribute('alt', '');
    el.appendChild(img);
    document.body.appendChild(el);
    const { html } = toWechatClipboardPayload(el);
    el.remove();
    return html;
  }

  it('http(s) 与位图 data URL 原样保留', () => {
    expect(payloadFor('https://example.com/a.png')).toContain('https://example.com/a.png');
    expect(payloadFor('data:image/png;base64,AAAA')).toContain('data:image/png;base64,AAAA');
    expect(payloadFor('./local.png')).toContain('./local.png');
  });

  it('非图片 data URL / javascript: / 含 .. 的路径换成透明占位（不静默删图）', () => {
    const blocked = payloadFor('data:text/html;base64,PHNjcmlwdD4=');
    expect(blocked).not.toContain('text/html');
    expect(blocked).toContain('data:image/png;base64,');
    expect(payloadFor('javascript:alert(1)')).not.toContain('javascript:');
    expect(payloadFor('../../etc/passwd')).not.toContain('..');
  });
});
