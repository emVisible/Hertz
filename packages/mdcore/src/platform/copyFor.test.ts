/**
 * `copyForWechat` / `copyForZhihu` 的**接线**判据。
 *
 * 这一片是被自己的缺陷逼出来的：给 copy 路径接上 Shiki/Mermaid 富集时，
 * IR 分支（**产品真正走的那条**）改成了 `return payload`，把 `copyToClipboard`
 * 落在了 DOM 分支上——payload 照常生成，结构断言全绿，而"复制到公众号"
 * 按钮**静默失效**（用户点完什么都没发生，没有任何报错）。
 *
 * 这正是 handover §4 记的那条：「纯函数对了不等于接线对了」。
 * 所以这里钉的不是 payload 内容（wechat.test.ts 管那个），而是
 * **两条分支都必须真的写进剪贴板**。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  copyForWechat,
  copyForZhihu,
  parseToIR,
  setCodeHighlighter,
  type WechatPayload,
} from '../index';

const written: Array<{ html: string; text: string }> = [];

/** 记账型 ClipboardItem：copyToClipboard 的首选通道需要它与 navigator.clipboard 同时在场 */
class FakeClipboardItem {
  constructor(private readonly items: Record<string, Blob>) {}
  getType(type: string): Promise<Blob> {
    const blob = this.items[type];
    if (!blob) return Promise.reject(new Error(`no such type: ${type}`));
    return Promise.resolve(blob);
  }
}

/** 装一个"会记账的剪贴板" */
function installClipboard(): void {
  written.length = 0;
  vi.stubGlobal('ClipboardItem', FakeClipboardItem);
  vi.stubGlobal('navigator', {
    clipboard: {
      write: async (items: FakeClipboardItem[]) => {
        written.push({
          html: await items[0].getType('text/html').then((b) => b.text()),
          text: await items[0].getType('text/plain').then((b) => b.text()),
        });
      },
    },
  });
}

afterEach(() => {
  setCodeHighlighter(null);
  vi.unstubAllGlobals();
});

describe('复制到剪贴板真的发生（两条分支都要写）', () => {
  it('copyForWechat(ir) —— IR 分支（产品路径）写进剪贴板', async () => {
    installClipboard()
    const payload: WechatPayload = await copyForWechat(parseToIR('# 标题\n\n正文'), 'modi')
    expect(written).toHaveLength(1)
    expect(written[0].html).toBe(payload.html)
    expect(written[0].text).toContain('正文')
  })

  it('copyForWechat(dom) —— DOM 分支也写', async () => {
    installClipboard()
    const el = document.createElement('section')
    el.textContent = '已经富集好的 DOM'
    document.body.appendChild(el)
    try {
      await copyForWechat(el as HTMLElement)
    } finally {
      el.remove()
    }
    expect(written).toHaveLength(1)
    expect(written[0].html).toContain('已经富集好的 DOM')
  })

  it('copyForZhihu(ir) 同样写进剪贴板', async () => {
    installClipboard()
    await copyForZhihu(parseToIR('# 标题\n\n正文'), 'xueshu', {}, { captureTable: null })
    expect(written).toHaveLength(1)
    expect(written[0].html).toContain('正文')
  })

  it('富集先于写剪贴板：Shiki 的内联色出现在 payload 里（而不是被清洗掉）', async () => {
    installClipboard()
    setCodeHighlighter(async () => '<span style="color:#ff0000">shiki</span>')
    await copyForWechat(parseToIR('```ts\nconst a = 1\n```'), 'modi')
    // 注意颜色值是**规范化后**的 rgb()：微信/知乎走的是"渲染态快照内联"
    // （getComputedStyle 逐节点写回白名单属性），jsdom 会把 #ff0000 归一化。
    // 这正说明内联色**落在产物里**——class 会被剥掉，style 才留得住。
    expect(written[0].html).toContain('shiki')
    expect(written[0].html).toContain('color: rgb(255, 0, 0)')
  })
})