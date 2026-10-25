/**
 * 语法覆盖守卫（切片 1）。
 *
 * 为什么先写"会红"的判据：解析层遇到不认识的 token 只能二选一——丢，或者原样带出来。
 * 早先选的是「丢」，于是 `~~删除线~~`、定义列表、脚注正文会在成品里整段消失，
 * 而 190 条结构断言一条都不红：**它们压根不知道存在这些语法**。
 *
 * 这份判据把「一篇稿子用到的每种 token，是否都进了 IR」变成可数的事实：
 * ①覆盖样例走一遍，未建模集合必须为空（红 = 真实缺口清单）；
 * ②注入未知 token 时，必须记账且原文仍在（守卫本身有效）。
 */
import { describe, expect, it } from 'vitest';
import {
  applyTheme,
  getMarkdownParser,
  parseToIRDetailed,
  type IRBlock,
  type InlineNode,
} from '../index';
import { tokensToIR } from './parseToIR';

/** 覆盖样例：把本仓注册的全部语法插件都点一遍 */
const KITCHEN_SINK = [
  '# 标题',
  '',
  '正文有 ==荧光==、**粗**、*斜*、~~删除~~、`行内码`、H~2~O、E=mc^2^、<ruby>注音<rt>zhuyin</rt></ruby>。',
  '',
  '- 列表项',
  '  - 嵌套项',
  '- [x] 已完成',
  '- [ ] 未完成',
  '',
  '> 引用',
  '>',
  '> > 嵌套引用',
  '',
  '> [!NOTE]',
  '> 提示块',
  '',
  ':::tip',
  '容器提示',
  ':::',
  '',
  '```ts',
  'const a: number = 1',
  '```',
  '',
  '| 表头 | 二 |',
  '| --- | ---: |',
  '| a | b |',
  '',
  '![图](https://e.com/a.png)',
  '',
  '$E = mc^2$',
  '',
  '$$\\int_0^1 x\\,dx$$',
  '',
  '[链接](https://e.com)',
  '',
  '[toc]',
  '',
  '脚注引用[^1]',
  '',
  '[^1]: 脚注正文',
  '',
  '术语',
  ': 定义',
  '',
  ':sunny: 表情与 #话题 与 [color:#f00]彩色[/color]',
  '',
  '---',
  '',
  '结尾。',
].join('\n');

/** 直接对 token 流跑一遍带诊断的转换（守卫要能构造 mdcore 没见过的流） */
function parseTokensWithDiag(tokens: Parameters<typeof tokensToIR>[0]): {
  blocks: IRBlock[]
  diagnostics: Array<{ token: string; count: number; line: number | null }>
} {
  // parseToIRDetailed 走的是同一条转换路径的公开入口；这里用它的等价物重建 ctx
  const md = getMarkdownParser();
  void md;
  const ctx = { diagnostics: [] as Array<{ token: string; count: number; line: number | null }> };
  const blocks = tokensToIR(tokens as never, ctx as never);
  return { blocks, diagnostics: ctx.diagnostics };
}

function unmodeled(md: string): string[] {
  return parseToIRDetailed(md).diagnostics.map((d) => d.token).sort();
}

/** IR 全文（含行内），用于断言"内容还在" */
function irText(blocks: IRBlock[]): string {
  const inline = (nodes: InlineNode[]): string =>
    nodes
      .map((n) => {
        const node = n as unknown as Record<string, unknown>;
        switch (node.type) {
          case 'text':
          case 'code':
            return String(node.text ?? '');
          case 'tag':
            return `#${node.text}`;
          case 'footnoteRef':
            return `[${node.id}]`;
          case 'html':
            return String(node.html ?? '');
          case 'formula':
            return String(node.tex ?? '');
          case 'image':
            return String(node.alt ?? '');
          case 'break':
            return '\n';
          case 'strong':
          case 'em':
          case 'mark':
          case 'sub':
          case 'sup':
          case 'link':
            return inline(node.children as InlineNode[] ?? []);
          case 'ruby':
            return inline((node.base as InlineNode[]) ?? []);
          default:
            return '';
        }
      })
      .join('');
  return blocks
    .map((b) => {
      const block = b as Record<string, unknown>;
      if ('children' in block) return inline(block.children as InlineNode[]);
      if (block.type === 'code') return String(block.code ?? '');
      if (block.type === 'image') return String(block.alt ?? '');
      if (block.type === 'formula') return String(block.tex ?? '');
      if (block.type === 'hr') return '';
      if (block.type === 'table') {
        // 表格在列表项里也是常见内容，助手读不出表格就会把"内容消失"误判成失败
        // 形状（实测）：header = 单元格[]；rows = 行[]（每行是单元格[]）
        const head = (block.header as unknown as InlineNode[][]) ?? [];
        const rows = (block.rows as unknown as InlineNode[][][]) ?? [];
        return [...head, ...rows.flat()]
          .map((cell) => inline(cell))
          .join(' ');
      }
      if (block.type === 'toc')
        return (block.items as Array<{ text: string }>).map((i) => i.text).join('\n');
      if (block.type === 'deflist')
        return (block.items as Array<{ term: InlineNode[]; defs: InlineNode[][] }>)
          .map((item) => [inline(item.term), ...item.defs.map((d) => inline(d))].join(' '))
          .join('\n');
      if (block.type === 'footnotes')
        return (block.items as Array<{ blocks: IRBlock[] }>).map((i) => irText(i.blocks)).join('\n');
      if ('blocks' in block) return irText(block.blocks as IRBlock[]);
      if (block.type === 'list')
        // 列表项现在分 inlines / blocks 两半（项内可以同现行内与块级内容）
        return (block.items as Array<{ inlines: InlineNode[]; blocks: IRBlock[] }>)
          .map((item) => [inline(item.inlines), ...item.blocks.map((b) => irText([b]))].join(' '))
          .join('\n');
      if ('items' in block)
        return (block.items as InlineNode[][]).map((item) => inline(item)).join('\n');
      if ('header' in block) return inline(block.header as InlineNode[]);
      return '';
    })
    .join('\n');
}

describe('语法覆盖', () => {
  it('厨房水槽样例：未建模语法集合为空（红了就是真实缺口清单）', () => {
    expect(unmodeled(KITCHEN_SINK)).toEqual([]);
  });

  it('解析诊断是可选信息，不影响 parseToIR 的产出（快路径同源）', () => {
    const detailed = parseToIRDetailed('# 标题');
    expect(detailed.blocks[0].type).toBe('heading');
    expect(Array.isArray(detailed.diagnostics)).toBe(true);
  });
});

describe('未建模语法的兜底行为', () => {
  it('删除线：内容保住了（画不画删除线是样式缺口，不是丢内容）', () => {
    const text = irText(parseToIRDetailed('前面~~被划掉的字~~后面').blocks);
    expect(text).toContain('被划掉的字');
    expect(text).toContain('前面');
    expect(text).toContain('后面');
    // s_open 被 findCloseInline 配平并降级成普通文本组，所以不算未建模
    expect(unmodeled('~~x~~')).toEqual([]);
  });

  it('定义列表：术语与释义都进 IR（此前 dl_* 整块被丢）', () => {
    const { blocks, diagnostics } = parseToIRDetailed('术语\n: 释义一\n: 释义二');
    expect(diagnostics).toEqual([]);
    const dl = blocks.find((b) => b.type === 'deflist') as Extract<IRBlock, { type: 'deflist' }> | undefined;
    expect(dl?.items).toHaveLength(1);
    expect(dl?.items[0].defs).toHaveLength(2); // 一个术语可以有多条释义
    expect(irText(blocks)).toContain('释义二');
  });

  it('脚注：正文进文末脚注区，引用点是可回跳的角标', () => {
    const { blocks, diagnostics } = parseToIRDetailed('正文引用[^a]\n\n[^a]: 脚注正文内容');
    expect(diagnostics).toEqual([]);
    const area = blocks.find((b) => b.type === 'footnotes') as Extract<IRBlock, { type: 'footnotes' }> | undefined;
    expect(area?.items).toHaveLength(1);
    expect(area?.items[0].label).toBe('a');
    expect(irText(blocks)).toContain('脚注正文内容');
    // 角标节点（不是纯文本 `[1]`）
    const para = blocks.find((b) => b.type === 'para') as Extract<IRBlock, { type: 'para' }>;
    expect(para.children.some((c) => c.type === 'footnoteRef')).toBe(true);
  });

  it('记账含类型、次数与行号（能定位到稿子里的哪一处）', () => {
    const { diagnostics } = parseTokensWithDiag([
      { type: 'paragraph_open', map: [0, 1] },
      { type: 'inline', children: [], map: [0, 1] },
      { type: 'paragraph_close', map: [0, 1] },
      { type: 'future_a', content: '甲', map: [2, 3] },
      { type: 'future_a', content: '乙', map: [4, 5] },
    ] as never);
    const hit = diagnostics.find((d) => d.token === 'future_a');
    expect(hit?.count).toBe(2);
    expect(hit?.line).toBe(2); // 首次出现的位置，不是最后一次
  });

  it('同一语法在一篇里只记一条（清单不会变成流水账）', () => {
    const { diagnostics } = parseTokensWithDiag([
      { type: 'future_b', content: '甲', map: [0, 1] },
      { type: 'future_b', content: '乙', map: [1, 2] },
    ] as never);
    expect(diagnostics.filter((d) => d.token === 'future_b')).toHaveLength(1);
  });

  it('注入一个未知的块级 token：记账 + 内容保留（守卫本身有效）', () => {
    const md = getMarkdownParser();
    const tokens = md.parse('正常段落', {});
    // 模拟"某个插件升级后新增了一种块级语法"。放在段落**外面**才是块级语法的真实位置
    tokens.push({
      type: 'future_block_9999',
      content: '来自未来的内容',
      map: [1, 2],
    } as unknown as (typeof tokens)[number]);
    const { blocks, diagnostics } = parseTokensWithDiag(tokens);
    expect(irText(blocks)).toContain('来自未来的内容');
    expect(diagnostics.map((d) => d.token)).toContain('future_block_9999');
  });

  it('注入一个未知的行内 token：记账 + 内容保留', () => {
    const md = getMarkdownParser();
    const tokens = md.parse('正常段落', {});
    const kids = tokens[1].children ?? [];
    kids.splice(1, 0, {
      type: 'future_inline_9999',
      content: '行内未来内容',
    } as unknown as (typeof kids)[number]);
    const { blocks, diagnostics } = parseTokensWithDiag(tokens);
    expect(irText(blocks)).toContain('行内未来内容');
    expect(diagnostics.map((d) => d.token)).toContain('future_inline_9999');
  });

  it('未知结构 token（无内容）不插空段：正文不凭空多出空行', () => {
    const md = getMarkdownParser();
    const tokens = md.parse('正常段落', {});
    tokens.push({
      type: 'future_empty_9999',
      content: '',
      map: null,
    } as unknown as (typeof tokens)[number]);
    const { blocks } = parseTokensWithDiag(tokens);
    expect(blocks).toHaveLength(1);
    expect(irText(blocks)).toBe('正常段落');
  });
});
/**
 * 列表项里的**块级内容不许消失**（切片 13）。
 *
 * 这是核对人话「部分 md 渲染不完全」时挖出来的，比标题那条重得多：
 *
 *   - 甲\n\n  ```js\n  const a = 1\n  ```\n\n- 丙   →  成品里只剩「• 甲 • 丙」
 *   - 嵌套列表 / 表格 / 引用                              →  被压平成一行文字
 *
 * `collectListItems` 早先只挑 `inline` token，其余**静默丢弃**——代码块整段消失，
 * 而 190 条结构断言一条都不红：它们不知道列表项里可以有块。
 * 这正是 handover §4 那一类「内容整段从成品里消失且无人察觉」。
 *
 * 判据钉两件事：①**内容一定还在**（这是底线）；②**结构尽量保住**（块级内容仍是块）。
 */
describe('列表项里的块级内容', () => {
  const cases: Record<string, string> = {
    代码块: '- 甲\n\n  ```js\n  const a = 1\n  ```\n\n- 丙',
    嵌套无序: '- 甲\n  - 乙\n  - 丙\n- 丁',
    嵌套有序: '1. 甲\n   1. 乙\n2. 丙',
    表格: '- 甲\n\n  | a | b |\n  | --- | --- |\n  | 1 | 2 |',
    引用: '- 甲\n  > 引用乙\n- 丙',
    标题: '- ## 小标题\n- 正文。',
    松散多段: '- 第一段\n\n  第二段\n\n- 下一项',
  };

  it.each(Object.keys(cases))('%s：内容一个字符都不许丢', (name) => {
    const ir = parseToIRDetailed(cases[name]);
    const text = irText(ir.blocks);
    // 逐个点名那些"曾经整段消失"的东西
    const mustHave: Record<string, string[]> = {
      代码块: ['const a = 1'],
      嵌套无序: ['甲', '乙', '丙', '丁'],
      嵌套有序: ['甲', '乙', '丙'],
      表格: ['a', 'b', '1', '2'],
      引用: ['甲', '引用乙', '丙'],
      标题: ['小标题', '正文'],
      松散多段: ['第一段', '第二段', '下一项'],
    };
    for (const needle of mustHave[name]) {
      expect(text, `${name}：内容「${needle}」消失了`).toContain(needle);
    }
  });

  it.each(Object.keys(cases))('%s：块级内容仍渲染成块（不是压平成一行）', (name) => {
    const ir = parseToIRDetailed(cases[name]);
    const list = ir.blocks.find((b) => b.type === 'list') as { items: unknown[] } | undefined;
    expect(list, `${name}：列表都没解析出来`).toBeTruthy();
    const rendered = applyTheme(ir.blocks, 'modi');
    // 只要项里有块级内容，渲染态就该出现对应的元素类型
    const html = rendered.innerHTML;
    if (name === '代码块') expect(html).toContain('<pre');
    if (name === '表格') expect(html).toContain('<table');
    if (name === '嵌套无序' || name === '嵌套有序') expect(html.match(/<ul|<ol/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    if (name === '引用') expect(html).toContain('blockquote');
    if (name === '标题') expect(html).toMatch(/<h[1-6]/);
  });

  it('没有静默丢弃：降级到文字时要有诊断', () => {
    // 上面七条现在都保住了结构，所以不该再有 list-item 相关的诊断；
    // 这条守着"将来有人改回去时，至少诊断会先红"
    for (const [name, md] of Object.entries(cases)) {
      const diags = parseToIRDetailed(md).diagnostics.filter((d) => d.token.startsWith('list-item'));
      expect(diags, `${name} 出现了 list-item 降级`).toEqual([]);
    }
  });
});

/**
 * W5 语法补齐：作者真会写、我们却吐字面量的两种语法。
 *
 * ①`汉字{拼音|hàn zì}`（markdown-it-ruby）——**令牌早就产出来了**，
 *   `InlineNode` 早就有 `ruby` 这个类型，可 `convertInline` 里那条分支写的是
 *   `case 'ruby'`，而令牌类型叫 `ruby_open`。一处字符的错，让整个拼音语法
 *   降级成文字并记一笔诊断——而诊断只说"没支持"，没人知道**支持的写法就在
 *   同一份 switch 里等着**。`<ruby>` 手写标签那条一直能用，所以更没人发现。
 *
 * ②`++插入++`——插件压根没装，于是原样吐字面量，**而且没有任何诊断**
 *   （没有令牌，自然无从记账）。这是最糟的一类缺口：它不报错、不留痕，
 *   只是安静地在成品里显示成 `++插入++`。
 */
describe('W5：拼音与插入', () => {
  it('拼音：{拼音|注音} 出真 <ruby>，不再是字面量', () => {
    const ir = parseToIRDetailed('汉字{拼音|hàn zì}');
    expect(ir.diagnostics, '拼音不该再降级（诊断应当为空）').toEqual([]);
    const ruby = ir.blocks[0] as { children?: Array<{ type: string }> };
    const kinds = (ruby.children ?? []).map((c) => c.type);
    expect(kinds).toContain('ruby');
  });

  it('拼音：手写 <ruby> 与 {…|…} 两条路都能出 ruby 元素', () => {
    const a = applyTheme(parseToIRDetailed('汉字{拼音|hàn zì}').blocks, 'modi');
    const b = applyTheme(parseToIRDetailed('<ruby>汉字<rt>hàn zì</rt></ruby>').blocks, 'modi');
    expect(a.querySelectorAll('ruby').length).toBeGreaterThan(0);
    expect(b.querySelectorAll('ruby').length).toBeGreaterThan(0);
  });

  it('插入：++文字++ 进 <ins>，不再吐字面量', () => {
    const ir = parseToIRDetailed('这是++插入++内容');
    const el = applyTheme(ir.blocks, 'modi');
    expect(el.querySelector('ins'), '++插入++ 没有变成 <ins>').toBeTruthy();
    expect(el.textContent ?? '').not.toContain('++')
  });

  it('插入：单个 + 不是插入（邮箱、算式不能被吃）', () => {
    for (const md of ['联系 a+b.com', '1+1=2', 'C++ 语言']) {
      const el = applyTheme(parseToIRDetailed(md).blocks, 'modi')
      expect(el.querySelector('ins'), `${md} 被误判成插入`).toBeNull()
    }
  })

  it('插入：内容含空格/换行时不成立（`++ 插入 ++` 多半是误触）', () => {
    // 这条守的是"三条硬约束"里的②：不拦空白的话，`++ 插入 ++` 会被当成插入，
    // 而中文正文里 `++` 两侧常带空格——作者随手敲就会中招。
    const cases = ['这是 ++ 插入 ++ 内容', '甲\n++\n乙', '++ 多行\n内容 ++']
    for (const md of cases) {
      const el = applyTheme(parseToIRDetailed(md).blocks, 'modi')
      expect(el.querySelector('ins'), `${JSON.stringify(md)} 被误判成插入`).toBeNull()
    }
  })

  it('插入：\\+\\+转义后按字面量输出', () => {
    const el = applyTheme(parseToIRDetailed('\\+\\+不是插入\\+\\+').blocks, 'modi')
    expect(el.querySelector('ins')).toBeNull()
    expect(el.textContent ?? '').toContain('++')
  })
});
