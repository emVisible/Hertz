import { describe, expect, it } from 'vitest';
import { parseToIR } from '../index';
import type { IRBlock } from '../ir/types';

/**
 * 覆盖全部块型的代表样例。行号 = markdown-it token.map（0 起、end 开区间）。
 * 用数组逐行构造，行号断言从数组下标推导，避免手写魔法数。
 */
const LINES = [
  '# 标题一', // 0
  '', // 1
  '这是一段包含 **加粗** 与 *斜体* 和 `code` 的文字。', // 2
  '', // 3
  '- 项目一', // 4
  '- 项目二', // 5
  '', // 6
  '```js', // 7
  'const a = 1;', // 8
  '```', // 9
  '', // 10
  '| 列A | 列B |', // 11
  '| --- | --- |', // 12
  '| a | b |', // 13
  '', // 14
  '> 引用内容', // 15
  '', // 16
  '![示意图](https://example.com/x.png)', // 17
  '', // 18
  ':::warning', // 19
  '小心警告', // 20
  ':::', // 21
  '', // 22
  '$$', // 23
  'E = mc^2', // 24
  '$$', // 25
  '', // 26
  '---', // 27
];
const SAMPLE = LINES.join('\n');

function lineOf(text: string): number {
  const idx = LINES.findIndex((l) => l.includes(text));
  if (idx < 0) throw new Error(`sample line not found: ${text}`);
  return idx;
}

function lastLineOf(text: string): number {
  const idx = LINES.findLastIndex((l) => l.includes(text));
  if (idx < 0) throw new Error(`sample line not found: ${text}`);
  return idx;
}

function blocksOfType(ir: IRBlock[], type: IRBlock['type']): IRBlock[] {
  return ir.filter((b) => b.type === type);
}

describe('parseToIR：全块型快照', () => {
  const ir = parseToIR(SAMPLE);

  it('块类型序列与顺序正确', () => {
    expect(ir.map((b) => b.type)).toEqual([
      'heading',
      'para',
      'list',
      'code',
      'table',
      'quote',
      'image',
      'callout',
      'formula',
      'hr',
    ]);
  });

  it('源码行号（token.map 0 起 end 开区间）', () => {
    const [heading, , list, code, table, quote, image, callout, formula, hr] = ir;
    expect(heading.line).toEqual([lineOf('# 标题一'), lineOf('# 标题一') + 1]);
    // markdown-it 的 list token.map 会吞掉列表后的空行（end 多 1 行），按其实际行为断言
    expect(list.line).toEqual([lineOf('- 项目一'), lineOf('- 项目二') + 2]);
    expect(code.line).toEqual([lineOf('```js'), lastLineOf('```') + 1]);
    expect(table.line).toEqual([lineOf('| 列A'), lineOf('| a | b |') + 1]);
    expect(quote.line).toEqual([lineOf('> 引用内容'), lineOf('> 引用内容') + 1]);
    expect(image.line).toEqual([lineOf('![示意图]'), lineOf('![示意图]') + 1]);
    // markdown-it-container 的 map = [开 fence 行, 闭 fence 行]（end 不是开区间），按其实际行为断言
    expect(callout.line).toEqual([lineOf(':::warning'), lastLineOf(':::')]);
    expect(formula.line).toEqual([lineOf('$$'), lastLineOf('$$') + 1]);
    expect(hr.line).toEqual([LINES.indexOf('---'), LINES.indexOf('---') + 1]);
  });

  it('heading 带级别与 inline 结构', () => {
    const [h] = blocksOfType(ir, 'heading');
    expect(h).toMatchObject({
      type: 'heading',
      level: 1,
      children: [{ type: 'text', text: '标题一' }],
    });
  });

  it('para inline 结构：strong/em/code', () => {
    const [p] = blocksOfType(ir, 'para');
    if (p.type !== 'para') throw new Error('unreachable');
    const kinds = p.children.map((c) => c.type);
    expect(kinds).toContain('strong');
    expect(kinds).toContain('em');
    expect(kinds).toContain('code');
    const strong = p.children.find((c) => c.type === 'strong');
    expect(strong).toMatchObject({ children: [{ type: 'text', text: '加粗' }] });
  });

  it('list 带 items', () => {
    const [l] = blocksOfType(ir, 'list');
    expect(l).toMatchObject({ type: 'list', ordered: false });
    if (l.type !== 'list') throw new Error('unreachable');
    expect(l.items).toHaveLength(2);
    expect(l.items[0]).toEqual([{ type: 'text', text: '项目一' }]);
  });

  it('code 带语言与原文', () => {
    const [c] = blocksOfType(ir, 'code');
    expect(c).toMatchObject({ type: 'code', lang: 'js', code: 'const a = 1;\n' });
  });

  it('table 带表头与数据行', () => {
    const [t] = blocksOfType(ir, 'table');
    if (t.type !== 'table') throw new Error('unreachable');
    expect(t.header).toHaveLength(2);
    expect(t.header[0]).toEqual([{ type: 'text', text: '列A' }]);
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0][1]).toEqual([{ type: 'text', text: 'b' }]);
  });

  it('quote/callout 递归包含子块', () => {
    const [q] = blocksOfType(ir, 'quote');
    if (q.type !== 'quote') throw new Error('unreachable');
    expect(q.blocks[0]).toMatchObject({ type: 'para' });

    const [co] = blocksOfType(ir, 'callout');
    if (co.type !== 'callout') throw new Error('unreachable');
    expect(co.variant).toBe('warning');
    expect(co.blocks[0]).toMatchObject({ type: 'para' });
  });

  it('formula 带 tex', () => {
    const [f] = blocksOfType(ir, 'formula');
    expect(f).toMatchObject({ type: 'formula', tex: 'E = mc^2', displayMode: true });
  });

  it('image 块（独立段落的单图提升为 image）', () => {
    const [img] = blocksOfType(ir, 'image');
    expect(img).toMatchObject({
      type: 'image',
      src: 'https://example.com/x.png',
      alt: '示意图',
    });
  });
});

describe('parseToIR：插件集成不炸', () => {
  it('footnote + attrs + 行内公式可解析', () => {
    const ir = parseToIR('带脚注[^a]与行内公式 $x^2$。\n\n[^a]: 注脚\n');
    expect(ir.length).toBeGreaterThan(0);
    const para = ir[0];
    if (para.type !== 'para') throw new Error('expected para');
    const kinds = para.children.map((c) => c.type);
    expect(kinds).toContain('formula'); // math_inline → formula inline
  });
});
