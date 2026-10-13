import { afterEach, describe, expect, it } from 'vitest';
import { applyTheme, parseToIR, wechatPayload } from '../index';

const MD = [
  '# 你好World',
  '',
  '这是Chinese和English混排，数字2026年见。',
  '',
  '看[示例链接](https://example.com/a)和[备用站](http://foo.bar/b)。',
  '',
  '```txt',
  'a  b',
  '\tc',
  '```',
  '',
].join('\n');

afterEach(() => {
  document.body.innerHTML = '';
});

function renderAndAttach(md: string): HTMLElement {
  const ir = parseToIR(md);
  const el = applyTheme(ir, 'modi');
  // 模拟真实场景：画布 DOM 是挂载态，getComputedStyle 才有值
  document.body.appendChild(el);
  return el;
}

describe('wechatPayload：渲染态快照内联产物', () => {
  it('无 class / id / <style>，无 var( 残留', () => {
    const { html } = wechatPayload(renderAndAttach(MD));
    expect(html).not.toMatch(/\sclass\s*=/);
    expect(html).not.toMatch(/\sid\s*=/);
    expect(html.toLowerCase()).not.toContain('<style');
    expect(html).not.toContain('var(');
  });

  it('mdcore 自己的块定位标记不进产物（data-mdcore-* 是编辑器状态，不是排版结果）', () => {
    const el = renderAndAttach(MD);
    // 渲染态里确实带着标记，否则下面那条 not.toContain 是空转
    expect(el.querySelector('[data-mdcore-block]')).not.toBeNull();
    const { html } = wechatPayload(el);
    expect(html).not.toContain('data-mdcore-');
  });

  it('样式以内联 style 形式存在', () => {
    const { html } = wechatPayload(renderAndAttach(MD));
    expect(html).toMatch(/<h1[^>]*\sstyle\s*=/);
  });

  it('pre 内空格/Tab 转 &nbsp;，且 overflow-x:auto', () => {
    const { html } = wechatPayload(renderAndAttach(MD));
    expect(html).toContain('&nbsp;');
    const preMatch = html.match(/<pre[^>]*style="([^"]*)"/);
    expect(preMatch).not.toBeNull();
    expect(preMatch![1]).toContain('overflow-x');
    // 原始双空格与 tab 不再以裸空格形式留在 pre 里
    const preBody = html.slice(html.indexOf('<pre'), html.indexOf('</pre>'));
    expect(preBody).not.toContain('a  b');
    expect(preBody).not.toContain('\t');
  });

  it('http 外链转上号角标 + 文末 References 列表', () => {
    const { html, text } = wechatPayload(renderAndAttach(MD));
    // 正文不再出现 <a href="http...">
    expect(html).not.toMatch(/<a[^>]+href="https?:\/\//);
    // 角标
    expect(html).toContain('<sup');
    expect(html).toContain('[1]');
    expect(html).toContain('[2]');
    // 文末 References
    const refIdx = html.indexOf('References');
    expect(refIdx).toBeGreaterThan(-1);
    expect(html.indexOf('https://example.com/a')).toBeGreaterThan(refIdx);
    expect(html.indexOf('http://foo.bar/b')).toBeGreaterThan(refIdx);
    // 纯文本副本同样带 References
    expect(text).toContain('References');
    expect(text).toContain('https://example.com/a');
  });

  it('pangu：中英文/中文数字之间插真实空格', () => {
    const { html } = wechatPayload(renderAndAttach(MD));
    expect(html).toContain('你好 World');
    expect(html).toContain('这是 Chinese 和 English 混排');
    expect(html).toContain('数字 2026 年');
  });

  it('结构扁平化：无 ul/li/div，只剩微信安全标签', () => {
    const md = '- 甲\n- 乙\n\n1. 一\n2. 二\n';
    const { html, text } = wechatPayload(renderAndAttach(md));
    expect(html.toLowerCase()).not.toContain('<ul');
    expect(html.toLowerCase()).not.toContain('<ol');
    expect(html.toLowerCase()).not.toContain('<li');
    expect(html.toLowerCase()).not.toContain('<div');
    // 列表项被拍平为 p；序号由渲染层自绘成 span（序号才能跟主色/用中文数字）
    expect(html).toMatch(/<span[^>]*>•<\/span>/);
    expect(html).toMatch(/<span[^>]*>1\.<\/span>/);
    // **序号只有一个**：适配器不得再补一份文本前缀（v0.36 之前正是两套符号叠着）
    const bullets = (text.match(/•/g) ?? []).length;
    expect(bullets, `无序序号出现 ${bullets} 次`).toBe(2);
    const numerals = (text.match(/\d\./g) ?? []).length;
    expect(numerals, `有序序号出现 ${numerals} 次`).toBe(2);
  });

  it('源画布 DOM 不被改动', () => {
    const el = renderAndAttach(MD);
    const before = el.innerHTML;
    wechatPayload(el);
    expect(el.innerHTML).toBe(before);
    expect(document.body.contains(el)).toBe(true);
  });

  it('接受 IR 直投（内部先 applyTheme）', () => {
    const { html } = wechatPayload(parseToIR('# 直投Test\n'), 'modi');
    expect(html).toContain('直投 Test');
    expect(html).not.toMatch(/\sclass\s*=/);
  });
});
