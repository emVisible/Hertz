import { describe, expect, it } from 'vitest';
import { applyTheme, getTheme, listThemes, parseToIR } from '../index';

describe('theme 注册表', () => {
  it('内置主题至少含墨滴/晚风两套微信向', () => {
    const list = listThemes();
    const ids = list.map((t) => t.id);
    expect(ids).toContain('modi');
    expect(ids).toContain('wanfeng');
    for (const t of list) {
      expect(t.name).toBeTruthy();
      expect(t.platform).toBeTruthy();
    }
  });

  it('getTheme 返回完整主题对象，未知 id 抛错', () => {
    const theme = getTheme('modi');
    expect(theme.tokens.color).toBeTruthy();
    expect(theme.tokens.fontFamily).toBeTruthy();
    expect(theme.tokens.fontSize).toBeTruthy();
    expect(theme.tokens.lineHeight).toBeTruthy();
    expect(theme.tokens.radius).toBeTruthy();
    expect(() => getTheme('no-such-theme')).toThrow();
  });
});

describe('applyTheme', () => {
  const ir = parseToIR('# 标题\n\n正文段落。\n');

  it('返回挂好样式的 DOM 容器', () => {
    const el = applyTheme(ir, 'modi');
    expect(el).toBeInstanceOf(HTMLElement);
    expect(el.querySelector('h1')?.textContent).toBe('标题');
    expect(el.querySelector('p')?.textContent).toBe('正文段落。');
    // token 落进内联样式
    const theme = getTheme('modi');
    expect(el.style.fontFamily).toContain(theme.tokens.fontFamily.split(',')[0].trim());
    expect(el.style.fontSize).toBe(theme.tokens.fontSize);
  });

  it('overrides 主色覆盖后产物 style 是新色值（装饰层，不是标题字色）', () => {
    // v0.36 起标题字色回到 headInk（主色留给装饰），所以「换色生效」要验装饰：
    // 墨滴默认 headingStyle=left-bar → 左边条应换成新主色，而标题字色仍是墨色。
    const base = getTheme('modi');
    const el = applyTheme(ir, base, { color: '#ff6600' });
    const h1 = el.querySelector('h1') as HTMLElement;
    const bar = h1.style.borderLeft;
    expect(bar).toContain('rgb(255, 102, 0)'); // jsdom 把 hex 规范化为 rgb()
    expect(h1.style.color === '#ff6600' || h1.style.color === 'rgb(255, 102, 0)').toBe(false);
  });

  it('overrides 字号覆盖后容器 style 是新字号', () => {
    const el = applyTheme(ir, 'modi', { fontSize: '18px' });
    expect(el.style.fontSize).toBe('18px');
  });

  it('主题对象与主题 id 两种入参等价', () => {
    const byId = applyTheme(ir, 'wanfeng');
    const byObj = applyTheme(ir, getTheme('wanfeng'));
    expect(byId.innerHTML).toBe(byObj.innerHTML);
  });

  it('每个顶层块带 data-mdcore-block / data-mdcore-line（画布点段落与拖分页边界的定位通道）', () => {
    const el = applyTheme(ir, 'modi');
    const blocks = Array.from(el.children) as HTMLElement[];
    expect(blocks.map((b) => b.getAttribute('data-mdcore-block'))).toEqual(['0', '1']);
    // 行号来自 markdown-it token.map：[start, end)，0 起
    expect(blocks[0].getAttribute('data-mdcore-line')).toBe('0-1');
    expect(blocks[1].getAttribute('data-mdcore-line')).toBe('2-3');
  });

  it('嵌套在引用里的子块不打标记（画布只与顶层块交互）', () => {
    const quoted = applyTheme(parseToIR('> 引用里的一段\n'), 'modi');
    const blockquote = quoted.querySelector('blockquote');
    expect(blockquote?.getAttribute('data-mdcore-block')).toBe('0');
    expect(blockquote?.querySelector('p')?.hasAttribute('data-mdcore-block')).toBe(false);
  });
});
