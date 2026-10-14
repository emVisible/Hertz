import { describe, expect, it } from 'vitest';
import { applyTheme, CALLOUT_TITLES, parseToIR } from '../index';
import type { IRBlock, InlineNode } from '../index';

/**
 * Phase 2a：中文排版常见件（判据）。
 *
 * 这批能力全部来自参考仓库的插件矩阵，但**实现落在 IR 层**：整条渲染链已经是
 * parse → IR → applyTheme（没有人渲染 markdown-it 的 HTML），所以规则只留一处作者，
 * 而不是在 markdown-it 插件层再写一遍。
 *
 * 钉的是 IR 结构 + 渲染产物两件事：解析对不对是一回事，产物里那个东西在不在、
 * 长什么样是另一回事。
 */

function firstInline(md: string): InlineNode[] {
  const block = parseToIR(md)[0] as IRBlock & { children?: InlineNode[] };
  return block.children ?? [];
}

describe('==荧光笔== 与行内标记', () => {
  it('==高亮== → mark 行内节点（带 hl 底色槽）', () => {
    const kids = firstInline('这是==重点==内容');
    const mark = kids.find((k) => k.type === 'mark') as Extract<InlineNode, { type: 'mark' }>;
    expect(mark).toBeTruthy();
    expect(mark.children.map((c) => (c as { text: string }).text).join('')).toBe('重点');
    // 产物里是 <mark>，且底色来自派生槽（主色的 hl 档）
    const el = applyTheme(parseToIR('这是==重点==内容'), 'modi');
    const node = el.querySelector('mark') as HTMLElement;
    expect(node).not.toBeNull();
    expect(node.style.backgroundColor).toBe('rgba(15, 118, 110, 0.26)');
  });

  it('H~2~O 与 E=mc^2^ → sub / sup（不是纯文本也不是 html）', () => {
    const kids = firstInline('H~2~O 与 E=mc^2^');
    expect(kids.some((k) => k.type === 'sub')).toBe(true);
    expect(kids.some((k) => k.type === 'sup')).toBe(true);
    const el = applyTheme(parseToIR('H~2~O'), 'modi');
    expect(el.querySelector('sub')?.textContent).toBe('2');
    expect(el.querySelector('sub')?.style.fontSize).toBe('0.72em');
  });

  it('注音 <ruby>：base 与 rt 分开，rt 是真 <rt> 标签', () => {
    const kids = firstInline('<ruby>注音<rt>zhuyin</rt></ruby>');
    const ruby = kids.find((k) => k.type === 'ruby') as Extract<InlineNode, { type: 'ruby' }>;
    expect(ruby).toBeTruthy();
    expect(ruby.rt.length).toBeGreaterThan(0);
    const el = applyTheme(parseToIR('<ruby>注音<rt>zhuyin</rt></ruby>'), 'modi');
    const node = el.querySelector('ruby') as HTMLElement;
    expect(node.querySelector('rt')?.textContent).toBe('zhuyin');
  });
});

describe('emoji 短码', () => {
  it(':sunny: → 真正的 emoji 字符（不是留下短码文本）', () => {
    const el = applyTheme(parseToIR('今天 :sunny: 天气不错'), 'modi');
    const text = el.querySelector('p')?.textContent ?? '';
    expect(text).toContain('☀');
    expect(text).not.toContain(':sunny:');
  });
});

describe('任务列表 → emoji 勾选框', () => {
  it('未完成 / 已完成分别出 ⬜ 与 ✅（微信清洗器会吃掉 <input>，所以必须换成字符）', () => {
    const done = applyTheme(parseToIR('- [x] 已完成'), 'modi');
    const todo = applyTheme(parseToIR('- [ ] 待办'), 'modi');
    expect(done.querySelector('li')?.textContent).toContain('✅');
    expect(todo.querySelector('li')?.textContent).toContain('⬜');
    // 产物里不能再有 input（它在公众号里会被整类剥掉）
    expect(done.querySelector('input')).toBeNull();
  });
});

describe('任务列表里的行内语法（label 不透明问题）', () => {
  it('任务项正文里的 emoji / 强调照常解析（label 里的整段不能是不透明的一坨）', () => {
    const el = applyTheme(parseToIR('- [ ] 主题只写性格 :sparkles: 与 **加粗**'), 'modi');
    const li = el.querySelector('li') as HTMLElement;
    expect(li.textContent).toContain('✨');
    expect(li.textContent).not.toContain(':sparkles:');
    expect(li.querySelector('strong')?.textContent).toBe('加粗');
  });
});

describe('GitHub Alert：> [!NOTE] → 提示块', () => {
  it('五种标记各自落到对应变体，且带标题', () => {
    const cases: Array<[string, string]> = [
      ['NOTE', 'note'],
      ['TIP', 'tip'],
      ['IMPORTANT', 'info'],
      ['WARNING', 'warning'],
      ['CAUTION', 'danger'],
    ];
    for (const [marker, variant] of cases) {
      const ir = parseToIR(`> [!${marker}]\n> 这一条要显示成提示块`);
      const block = ir[0] as IRBlock & { type: string; variant?: string };
      expect(block.type, `[!${marker}]`).toBe('callout');
      expect(block.variant).toBe(variant);
      expect(CALLOUT_TITLES[variant ?? '']).toBeTruthy();
      // 标记本身不能留在正文里
      const el = applyTheme(ir, 'modi');
      expect(el.textContent ?? '').not.toContain(`[!${marker}]`);
      expect(el.querySelector('.mdcore-callout')).not.toBeNull();
    }
  });

  it('不是 alert 的普通引用仍是 quote（别把引号吞掉）', () => {
    expect(parseToIR('> 普通引用\n')[0].type).toBe('quote');
    expect(parseToIR('> [!UNKNOWN]\n> 未知标记\n')[0].type).toBe('quote');
  });

  it('alert 正文的多段都保���', () => {
    const ir = parseToIR('> [!NOTE]\n> 第一段\n>\n> 第二段');
    const block = ir[0] as IRBlock & { blocks?: IRBlock[] };
    expect(block.blocks?.length).toBe(2);
  });
});

describe('三个插件的边界（别把它们开过头）', () => {
  it('== 不成对时不吞正文（单边 == 原样留着）', () => {
    const text = applyTheme(parseToIR('价格 == 100 元'), 'modi').textContent ?? '';
    expect(text).toContain('== 100');
    expect(text).not.toContain('100 元”');
  });

  it('markdown-it-mark 不吃掉行内代码里的 ==', () => {
    const text = applyTheme(parseToIR('`a == b` 的写法'), 'modi').textContent ?? '';
    expect(text).toContain('a == b');
  });
});