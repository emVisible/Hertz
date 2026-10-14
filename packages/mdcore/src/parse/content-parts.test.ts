import { describe, expect, it } from 'vitest';
import {
  applyTheme,
  headingAnchor,
  parseImageSizeSpec,
  parseToIR,
  xhsCaption,
  type IRBlock,
  type InlineNode,
} from '../index';

/**
 * Phase 2b：内容件（目录 / 话题 / 彩色文字 / 图宽对齐）判据。
 *
 * 这几件的共同形状是「长文真正会用到的排版零件」：目录让 20 段长文可跳读，
 * 话题与彩色文字是小红书/公众号的日常写法，`{60% left}` 是配图排布。
 * 全部落在 IR 层（行内扩展是核心规则，因为要在 text token 内部切段）。
 */
function blocks(md: string): IRBlock[] {
  return parseToIR(md);
}

function inlineText(nodes: InlineNode[]): string {
  return nodes
    .map((n) => {
      switch (n.type) {
        case 'text':
        case 'code':
          return n.text;
        case 'tag':
          return `#${n.text}`;
        case 'html':
          return n.html.replace(/<[^>]+>/g, '');
        default:
          return '';
      }
    })
    .join('');
}

describe('[toc] 目录', () => {
  const MD = ['[toc]', '', '# 大标题', '', '## 甲节', '', '内容', '', '### 甲一', '', '## 乙节', ''].join('\n');

  it('占位段落变成 toc 块，条目取自 2/3 级标题（1 级不算）', () => {
    const toc = blocks(MD)[0] as IRBlock & { type: string; items: Array<{ level: number; text: string }> };
    expect(toc.type).toBe('toc');
    expect(toc.items.map((i) => `${i.level}:${i.text}`)).toEqual(['2:甲节', '3:甲一', '2:乙节']);
  });

  it('标题带锚点且同名不撞车', () => {
    const toc = blocks(MD)[0] as IRBlock & { items: Array<{ anchor: string }> };
    expect(toc.items[0].anchor).toBe(headingAnchor(2, '甲节'));
    expect(toc.items[0].anchor).not.toBe(toc.items[2].anchor); // 同名不同序号
  });

  it('产物是可点的两行目录（L3 缩进一档）', () => {
    const el = applyTheme(parseToIR(MD), 'modi');
    const toc = el.querySelector('.mdcore-toc') as HTMLElement;
    expect(toc).not.toBeNull();
    const rows = Array.from(toc.querySelectorAll('.mdcore-toc-item')) as HTMLElement[];
    expect(rows).toHaveLength(3);
    expect(rows[0].querySelector('a')?.getAttribute('href')).toMatch(/^#h2-/);
    expect(rows[1].style.paddingLeft).toBe('1.2em');
  });

  it('没有 2/3 级标题时给一句提示，而不是空盒子', () => {
    const el = applyTheme(parseToIR('# 只有一级标题\n\n[toc]\n'), 'modi');
    expect(el.querySelector('.mdcore-toc-empty')).not.toBeNull();
  });

  it('正文里提到 [toc] 不算目录标记', () => {
    expect(blocks('正文里写了 [toc] 这个词')[0].type).toBe('para');
  });

  it('目录条目也进小红书文案（读者一眼看到结构）', () => {
    expect(xhsCaption(parseToIR(MD))).toContain('甲节');
  });
});

describe('#话题 与彩色文字', () => {
  it('#话题 被切成 tag 节点，产物里是带色的 span', () => {
    const el = applyTheme(parseToIR('今天聊 #AI 与 #设计'), 'modi');
    const p = el.querySelector('p') as HTMLElement;
    const tags = Array.from(p.querySelectorAll('.mdcore-tag')).map((t) => t.textContent);
    expect(tags).toEqual(['#AI', '#设计']);
    expect(p.textContent).toBe('今天聊 #AI 与 #设计');
    // 话题色跟主色（派生槽）
    expect((p.querySelector('.mdcore-tag') as HTMLElement).style.color).toBe('rgb(15, 118, 110)');
  });

  it('C# 与 a#b 不误伤（话题要成词、前面不能是标签字符）', () => {
    const text = inlineText((blocks('用 C# 写 C# 代码')[0] as IRBlock & { children: InlineNode[] }).children);
    expect(text).toBe('用 C# 写 C# 代码');
    expect(applyTheme(parseToIR('用 C# 写 C# 代码'), 'modi').querySelector('.mdcore-tag')).toBeNull();
  });

  it('[color:#xxx]文字[/color] → 受控 span（不是裸 HTML 标签）', () => {
    const el = applyTheme(parseToIR('重点是[color:#ff0000]这里[/color]'), 'modi');
    const span = Array.from(el.querySelectorAll('span')).find((s) => s.textContent === '这里');
    expect(span).toBeTruthy();
    expect((span as HTMLElement).style.color).toBe('rgb(255, 0, 0)');
    // 这条通道不能注入标签。路径说明：裸 `<script>` 会被 markdown-it 的 html 规则
    // 先摘成 html_inline（那是 markdown 源文本来就有的能力，见下），真正要防的是
    // 「实体解码后才露出来的尖括号」——它们回到文本层，落进这条通道。
    const ir = parseToIR('[color:#00ff00]\\<b\\>x[/color]');
    const kids = (ir[0] as IRBlock & { children: InlineNode[] }).children;
    const colored = kids.find((k) => k.type === 'html') as Extract<InlineNode, { type: 'html' }> | undefined;
    expect(colored?.html).toContain('&lt;b&gt;');
    expect(colored?.html).not.toContain('<b>');
    expect(applyTheme(parseToIR('[color:#00ff00]\\<b\\>x[/color]'), 'modi').innerHTML).not.toContain('<b>');
  });
});

describe('图宽与对齐 {60% left}', () => {
  it('解析出 width/align 并落到 img 上', () => {
    expect(parseImageSizeSpec('![图](a.png){60% left}')).toEqual({ width: '60%', align: 'left' });
    expect(parseImageSizeSpec('![图](a.png){100%}')).toEqual({ width: '100%', align: 'center' });
    expect(parseImageSizeSpec('没有这个记号')).toBeNull();
    const ir = blocks('![配图](a.png){60% left}');
    const img = ir[0] as IRBlock & { width?: string; align?: string };
    expect(img.width).toBe('60%');
    expect(img.align).toBe('left');
    const el = applyTheme(parseToIR('![配图](a.png){60% left}'), 'modi');
    const node = el.querySelector('img') as HTMLElement;
    expect(node.style.width).toBe('60%');
    expect(node.style.marginRight).toBe('auto');
    // jsdom 把 '0' 规范化成 '0px'，判据按规范化后的形式写
    expect(node.style.marginLeft).toBe('0px');
  });

  it('宽度被夹在 10%~100%（写 999% 也不能撑破画布）', () => {
    expect(parseImageSizeSpec('{999% right}')).toEqual({ width: '100%', align: 'right' });
    expect(parseImageSizeSpec('{2%}')).toEqual({ width: '10%', align: 'center' });
  });
});