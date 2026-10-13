import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyTheme,
  copyForZhihu,
  defaultThemeFor,
  parseToIR,
  zhihuPayload,
} from '../index';

/**
 * 知乎降级渲染器测试（§3.2/§7）：
 * 表格→占位图容器（浏览器 dataURL / jsdom 文本退化双路径）、公式→$$源码、
 * 有序列表→文本编号、嵌套列表拍平、产物无 class/id/<style>。
 */

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

function renderAndAttach(md: string): HTMLElement {
  const ir = parseToIR(md);
  const el = applyTheme(ir, defaultThemeFor('zhihu'));
  document.body.appendChild(el);
  return el;
}

const TABLE_MD = ['| 名称 | 价格 |', '| --- | --- |', '| 苹果 | 3 |', '| 香蕉 | 2 |', ''].join('\n');

describe('zhihuPayload：表格降级', () => {
  it('jsdom 路径：表格 → 带边框 div + 逐行文本', async () => {
    const { html, text } = await zhihuPayload(renderAndAttach(TABLE_MD));
    expect(html.toLowerCase()).not.toContain('<table');
    // 退化容器：带边框的 div
    expect(html).toMatch(/<div[^>]*style="[^"]*border/);
    // 逐行文本：表头在前，单元格以 | 分隔
    expect(html).toContain('名称 | 价格');
    expect(html).toContain('苹果 | 3');
    expect(html).toContain('香蕉 | 2');
    expect(html.indexOf('名称 | 价格')).toBeLessThan(html.indexOf('苹果 | 3'));
    expect(text).toContain('名称 | 价格');
  });

  it('浏览器路径（注入 captureTable）：表格 → div 内嵌 dataURL 快照 img', async () => {
    const dataUrl = 'data:image/png;base64,QUJD';
    const captured: HTMLTableElement[] = [];
    const { html } = await zhihuPayload(renderAndAttach(TABLE_MD), undefined, undefined, {
      captureTable: async (table) => {
        captured.push(table);
        return dataUrl;
      },
    });
    expect(captured.length).toBe(1);
    expect(html.toLowerCase()).not.toContain('<table');
    expect(html).toContain(`src="${dataUrl}"`);
    // 快照 img 仍在带边框的占位容器里
    expect(html).toMatch(/<div[^>]*style="[^"]*border[^"]*"[^>]*><img/);
  });

  it('captureTable 抛错 → 自动退化为文本容器', async () => {
    const { html } = await zhihuPayload(renderAndAttach(TABLE_MD), undefined, undefined, {
      captureTable: async () => {
        throw new Error('canvas unavailable');
      },
    });
    expect(html.toLowerCase()).not.toContain('<table');
    expect(html).toContain('名称 | 价格');
  });
});

describe('zhihuPayload：公式降级', () => {
  it('块级公式 → $$...$$ 包裹的 LaTeX 源码文本', async () => {
    const { html, text } = await zhihuPayload(renderAndAttach('$$\nE=mc^2\n$$\n'));
    expect(html).toContain('$$E=mc^2$$');
    expect(text).toContain('$$E=mc^2$$');
    // katex 渲染产物不复存在
    expect(html).not.toContain('katex');
    expect(html).not.toContain('<annotation');
  });

  it('行内公式 → $...$ 源码文本', async () => {
    const { html } = await zhihuPayload(renderAndAttach('质能方程 $E=mc^2$ 成立。\n'));
    expect(html).toContain('$E=mc^2$');
    expect(html).not.toContain('katex');
  });
});

describe('zhihuPayload：列表降级', () => {
  it('有序列表 → 保留 1. 文本编号的 p 序列', async () => {
    const { html } = await zhihuPayload(renderAndAttach('1. 一\n2. 二\n3. 三\n'));
    expect(html.toLowerCase()).not.toContain('<ol');
    expect(html.toLowerCase()).not.toContain('<li');
    const i1 = html.indexOf('1. 一');
    const i2 = html.indexOf('2. 二');
    const i3 = html.indexOf('3. 三');
    expect(i1).toBeGreaterThan(-1);
    expect(i2).toBeGreaterThan(i1);
    expect(i3).toBeGreaterThan(i2);
    // 编号是 p 的文本内容
    expect(html).toMatch(/<p[^>]*>1\. 一/);
  });

  it('无序列表 → • 前缀 p', async () => {
    const { html } = await zhihuPayload(renderAndAttach('- 甲\n- 乙\n'));
    expect(html.toLowerCase()).not.toContain('<ul');
    expect(html).toContain('• 甲');
    expect(html).toContain('• 乙');
  });

  it('嵌套列表拍平为同级 p 序列（序保持）', async () => {
    const el = document.createElement('section');
    el.innerHTML = '<ul><li>甲<ul><li>子一</li><li>子二</li></ul></li><li>乙</li></ul>';
    document.body.appendChild(el);
    const { html } = await zhihuPayload(el);
    expect(html.toLowerCase()).not.toContain('<ul');
    expect(html.toLowerCase()).not.toContain('<li');
    const order = ['• 甲', '• 子一', '• 子二', '• 乙'].map((s) => html.indexOf(s));
    for (const i of order) expect(i).toBeGreaterThan(-1);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

describe('zhihuPayload：产物规格（同微信 inline 快照）', () => {
  const MD = [
    '# 知乎标题',
    '',
    '正文Chinese和English混排，看[知乎](https://www.zhihu.com)。',
    '',
    '> 引用一段',
    '',
    '```txt',
    'a  b',
    '```',
    '',
    TABLE_MD,
  ].join('\n');

  it('无 class / id / <style>，无 var( 残留', async () => {
    const { html } = await zhihuPayload(renderAndAttach(MD));
    expect(html).not.toMatch(/\sclass\s*=/);
    expect(html).not.toMatch(/\sid\s*=/);
    expect(html.toLowerCase()).not.toContain('<style');
    expect(html).not.toContain('var(');
  });

  it('http 链接保留 <a href>（知乎支持链接卡片，不转脚注）', async () => {
    const { html } = await zhihuPayload(renderAndAttach(MD));
    expect(html).toContain('href="https://www.zhihu.com"');
    expect(html).not.toContain('References');
  });

  it('pangu：中英文之间插真实空格', async () => {
    const { html } = await zhihuPayload(renderAndAttach(MD));
    expect(html).toContain('正文 Chinese 和 English 混排');
  });

  it('源画布 DOM 不被改动', async () => {
    const el = renderAndAttach(MD);
    const before = el.innerHTML;
    await zhihuPayload(el);
    expect(el.innerHTML).toBe(before);
    expect(document.body.contains(el)).toBe(true);
  });

  it('接受 IR 直投（内部先 applyTheme，缺省知乎主题）', async () => {
    const { html } = await zhihuPayload(parseToIR('# 直投Test\n'));
    expect(html).toContain('直投 Test');
    expect(html).not.toMatch(/\sclass\s*=/);
  });
});

describe('copyForZhihu：ClipboardItem 双写', () => {
  it('text/html + text/plain 一次写入剪贴板', async () => {
    const written: Array<Record<string, Blob>> = [];
    class FakeClipboardItem {
      constructor(public items: Record<string, Blob>) {
        written.push(items);
      }
    }
    vi.stubGlobal('ClipboardItem', FakeClipboardItem);
    vi.stubGlobal('navigator', {
      clipboard: { write: async () => {} },
    });
    await copyForZhihu(renderAndAttach('# 标题\n\n正文。\n'));
    expect(written.length).toBe(1);
    expect(Object.keys(written[0]).sort()).toEqual(['text/html', 'text/plain']);
    expect(await written[0]['text/html'].text()).toContain('标题');
    expect(await written[0]['text/plain'].text()).toContain('正文');
  });
});
