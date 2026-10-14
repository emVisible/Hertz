import type Token from 'markdown-it/lib/token.mjs';
import { getMarkdownParser } from '../parse/markdown';
import type { IRBlock, IRDiagnostic, InlineNode, LayoutIR, LineRange } from './types';

/**
 * 解析上下文：把「未建模语法」记到哪儿。
 *
 * 为什么挂在参数上而不是模块级变量：mdcore 是单线程同步解析，模块级变量也能用，
 * 但那会让"嵌套解析（引用块/提示块再调一次 tokensToIR）"各自持有一份账，
 * 外层看不到内层的——记漏了就等于没记。
 */
interface ParseContext {
  diagnostics: IRDiagnostic[];
  /**
   * 降级兜底正在接管内部 token（脚注区等）：此时内部的结构 token 不逐个记账。
   *
   * 否则清单会长这样：`footnote_open` / `paragraph_open` / `paragraph_close` /
   * `footnote_close` —— 全是"已建模"的类型，只是被包在一个降级分支里。
   * 记一笔 `footnote_block_open`（「脚注区被当普通段落」）就够定位问题了。
   */
  quiet?: boolean;
}

/** 记一笔未建模语法（同一类型只记一条，count 累加） */
function note(ctx: ParseContext | undefined, token: Token): void {
  if (!ctx || ctx.quiet) return;
  const hit = ctx.diagnostics.find((d) => d.token === token.type);
  if (hit) {
    hit.count += 1;
    return;
  }
  ctx.diagnostics.push({ token: token.type, count: 1, line: token.map ? token.map[0] : null });
}

/**
 * markdown 字符串 → LayoutIR（§2：parse → IR 是唯一下游输入）。
 *
 * 这是给渲染用的快路径；要看到「这篇稿子里有几种语法还没建模」用
 * `parseToIRDetailed()`。两者共用同一条转换路径，不存在两份实现。
 */
export function parseToIR(markdown: string): LayoutIR {
  return parseToIRDetailed(markdown).blocks;
}

/** 带诊断的解析：blocks 与 `parseToIR` 完全同源，另给未建模语法清单 */
export function parseToIRDetailed(markdown: string): { blocks: LayoutIR; diagnostics: IRDiagnostic[] } {
  const md = getMarkdownParser();
  const tokens = md.parse(markdown, {});
  const ctx: ParseContext = { diagnostics: [] };
  const blocks = tokensToIR(tokens, ctx);
  fillToc(blocks);
  return { blocks, diagnostics: ctx.diagnostics };
}

/**
 * 给 `[toc]` 占位块补上目录条目。
 *
 * 为什么放在收尾而不是解析 `[toc]` 那一刻：目录要"整篇的标题"才能填，而流式转换
 * 时标题可能在 `[toc]` 之后才出现（大多数文章目录在开头，内容在下面）。
 * 标题锚点由 `headingAnchor()` 按「序号 + 标题文本」生成，重名也能对上。
 */
function fillToc(blocks: LayoutIR): void {
  const toc = blocks.find((b) => b.type === 'toc');
  if (!toc || toc.type !== 'toc') return;
  toc.items = blocks
    .filter((b) => b.type === 'heading' && b.level >= 2 && b.level <= 3)
    .map((b) => {
      const heading = b as Extract<IRBlock, { type: 'heading' }>;
      const text = inlinePlain(heading.children);
      return { level: heading.level, text, anchor: headingAnchor(heading.level, text) };
    });
}

/** 标题锚点：`h2-3-标题` ——序号保证同标题不撞车 */
export function headingAnchor(level: number, text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24);
  return `h${level}-${slug}`;
}

/** 行内节点 → 纯文本（目录条目、标题锚点都要） */
export function inlinePlain(nodes: InlineNode[]): string {
  return nodes
    .map((n) => {
      switch (n.type) {
        case 'text':
        case 'code':
          return n.text;
        case 'tag':
          return `#${n.text}`;
        case 'image':
          return n.alt;
        case 'formula':
          return n.tex;
        case 'break':
          return '\n';
        case 'html':
          return n.html.replace(/<[^>]+>/g, '');
        case 'ruby':
          return inlinePlain(n.base);
        case 'strong':
        case 'em':
        case 'mark':
        case 'sub':
        case 'sup':
        case 'link':
          return inlinePlain(n.children);
      }
    })
    .join('');
}

function lineOf(token: Token): LineRange | null {
  return token.map ? [token.map[0], token.map[1]] : null;
}

function attrOf(token: Token, name: string): string | null {
  return token.attrGet(name);
}

/** markdown-it token stream → LayoutIR 块序列 */
export function tokensToIR(tokens: Token[], ctx?: ParseContext): IRBlock[] {
  const blocks: IRBlock[] = [];
  let i = 0;

  while (i < tokens.length) {
    const t = tokens[i];

    // container_xxx_open / container_xxx_close（callout）
    if (t.type.startsWith('container_') && t.type.endsWith('_open')) {
      const variant = t.type.slice('container_'.length, -'_open'.length);
      const closeType = `${t.type.slice(0, -'_open'.length)}_close`;
      const end = findClose(tokens, i, t.type, closeType);
      blocks.push({
        type: 'callout',
        variant,
        blocks: tokensToIR(tokens.slice(i + 1, end), ctx),
        line: lineOf(t),
      });
      i = end + 1;
      continue;
    }

    switch (t.type) {
      case 'heading_open': {
        const end = findClose(tokens, i, 'heading_open', 'heading_close');
        const inline = tokens.slice(i + 1, end).find((tok) => tok.type === 'inline');
        blocks.push({
          type: 'heading',
          level: Number(t.tag.slice(1)),
          children: convertInline(inline?.children ?? [], ctx),
          line: lineOf(t),
        });
        i = end + 1;
        break;
      }

      case 'paragraph_open': {
        // 按深度配平取 inline，而不是"位置 +1/+3"。markdown-it 自己产的流里
        // paragraph_open 后面紧跟 inline，位置法一直成立；但只要流里多出任何
        // 一个 token（插件插入、脚注拆分），位置法就会取到空 children 并把真内容
        // 连同 paragraph_close 一起跳过——症状是"整段变空"，且极难归因。
        const end = findClose(tokens, i, 'paragraph_open', 'paragraph_close');
        const inline = tokens.slice(i + 1, end).find((tok) => tok.type === 'inline');
        const kids = inline?.children ?? [];
        // 独立段落里的单张图提升为 image 块
        if (kids.length === 1 && kids[0].type === 'image') {
          const spec = parseImageSizeSpec(inline?.content ?? '');
          blocks.push({
            type: 'image',
            src: attrOf(kids[0], 'src') ?? '',
            alt: kids[0].content ?? '',
            ...(spec ?? {}),
            line: lineOf(t),
          });
        } else if (isTocMarker(kids)) {
          // `[toc]` 占位：条目在整篇转换完后由 fillToc 补（见其头注）
          blocks.push({ type: 'toc', items: [], line: lineOf(t) });
        } else {
          blocks.push({ type: 'para', children: convertInline(kids, ctx), line: lineOf(t) });
        }
        i = end + 1;
        break;
      }

      case 'bullet_list_open':
      case 'ordered_list_open': {
        const ordered = t.type === 'ordered_list_open';
        const end = findClose(tokens, i, t.type, t.type.replace('_open', '_close'));
        const { items } = collectListItems(tokens.slice(i + 1, end), ctx);
        blocks.push({ type: 'list', ordered, items, line: lineOf(t) });
        i = end + 1;
        break;
      }

      case 'fence':
      case 'code_block': {
        blocks.push({
          type: 'code',
          lang: t.info.trim() || null,
          code: t.content,
          line: lineOf(t),
        });
        i += 1;
        break;
      }

      case 'table_open': {
        const end = findClose(tokens, i, 'table_open', 'table_close');
        blocks.push({ type: 'table', ...convertTable(tokens.slice(i + 1, end), ctx), line: lineOf(t) });
        i = end + 1;
        break;
      }

      case 'blockquote_open': {
        const end = findClose(tokens, i, 'blockquote_open', 'blockquote_close');
        const inner = tokens.slice(i + 1, end);
        const alert = parseGitHubAlert(inner, ctx);
        if (alert) {
          blocks.push({ type: 'callout', ...alert, line: lineOf(t) });
        } else {
          blocks.push({ type: 'quote', blocks: tokensToIR(inner, ctx), line: lineOf(t) });
        }
        i = end + 1;
        break;
      }

      case 'math_block': {
        blocks.push({ type: 'formula', tex: t.content.trim(), displayMode: true, line: lineOf(t) });
        i += 1;
        break;
      }

      case 'hr': {
        // `---` 是"换页"意图，`***`/`___` 是"分隔"意图（见 types.ts hr 的头注）
        blocks.push({ type: 'hr', kind: t.markup.trim() === '---' ? 'pagebreak' : 'rule', line: lineOf(t) });
        i += 1;
        break;
      }

      case 'html_block': {
        blocks.push({ type: 'para', children: [{ type: 'html', html: t.content }], line: lineOf(t) });
        i += 1;
        break;
      }

      case 'inline': {
        blocks.push({ type: 'para', children: convertInline(t.children ?? [], ctx), line: lineOf(t) });
        i += 1;
        break;
      }

      case 'dl_open': {
        const end = findClose(tokens, i, 'dl_open', 'dl_close');
        blocks.push({ type: 'deflist', items: collectDefItems(tokens.slice(i + 1, end), ctx), line: lineOf(t) });
        i = end + 1;
        break;
      }

      case 'footnote_block_open': {
        // 脚注定义区 → 文末脚注区。
        // 早先是 `i = end + 1` 直接跳过整块：「[^1]: 脚注正文内容」一个字都不剩，
        // 而没有任何断言会红（它们不知道有这个语法）。语法守卫第一次跑就报了它。
        const end = findClose(tokens, i, 'footnote_block_open', 'footnote_block_close');
        const items: Array<{ id: number; label: string; blocks: IRBlock[] }> = [];
        for (const group of groupFootnotes(tokens.slice(i + 1, end))) {
          items.push({
            id: group.id,
            label: group.label,
            blocks: tokensToIR(group.tokens, ctx),
          });
        }
        if (items.length) blocks.push({ type: 'footnotes', items, line: lineOf(t) });
        i = end + 1;
        break;
      }

      default: {
        // 未建模的块语法：**记一笔 + 尽力保内容**。
        // 早先这里是 `i += 1` 直接跳过，于是 `dl_open`（定义列表）、
        // `footnote_def`（脚注正文）这类 token 会在成品里整段消失，
        // 而没有任何断言会红——它们不知道有这个语法。
        note(ctx, t);
        const salvaged = salvageBlock(t);
        if (salvaged) blocks.push(salvaged);
        i += 1;
        break;
      }
    }
  }
  return blocks;
}

/**
 * 未建模块 token 的抢救：尽量把内容捞成一段文字，别让作者的稿子少一块。
 *
 * 规则刻意保守：只捞**确定是内容**的形态（有 inline 子节点 / 自带 content 的
 * 叶子 token）。捞不出内容的（纯结构性的 `*_open` / `*_close`）返回 null——
 * 宁可少一个空段，也不要在正文里插一段空行。
 */
function salvageBlock(t: Token): IRBlock | null {
  if (t.type === 'inline') {
    return { type: 'para', children: convertInline(t.children ?? []), line: lineOf(t) };
  }
  if (t.type === 'code_block') {
    return { type: 'code', lang: null, code: t.content, line: lineOf(t) };
  }
  if (t.type === 'fence') {
    return { type: 'code', lang: t.info.trim() || null, code: t.content, line: lineOf(t) };
  }
  if (t.type === 'html_block' && t.content.trim()) {
    return { type: 'para', children: [{ type: 'html', html: t.content }], line: lineOf(t) };
  }
  // 未知但自带内容的叶子 token（例如插件升级后新增的语法）：
  // 按纯文本救回来。作者写下的字不该因为我们没跟上就消失。
  if (t.content && t.content.trim()) {
    return { type: 'para', children: [{ type: 'text', text: t.content }], line: lineOf(t) };
  }
  return null;
}

/**
 * 收集一个列表的各个项（`tokens` 是本层 open 与 close 之间的内部序列）。
 *
 * 这里踩过一个很难发现的坑：早先的实现从 `list_item_open` 开始一路扫到
 * **第一个** `list_item_close` 就停，于是遇到嵌套列表时停在了**内层**那一项上，
 * 外层项的 close 被留在原地——从这里开始，后面每一个 token 的类型都与预期错开：
 * 第二个列表项退化成普通段落、任务列表的 checkbox 消失、紧接着的表格/引用全乱。
 * 结构层的断言碰不到它（它只断言了"单个列表项"），是切片 1 的语法守卫报出来的。
 *
 * 现在用 findClose 按**深度**配平：内层的 open/close 在这里被完整消费（嵌套项的
 * 行内内容并入父项，等切片 7 把它建模成真正的子树）。
 */
function collectListItems(
  tokens: Token[],
  ctx?: ParseContext,
): { items: InlineNode[][] } {
  const items: InlineNode[][] = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.type === 'list_item_open') {
      const end = findClose(tokens, i, 'list_item_open', 'list_item_close');
      const itemKids: InlineNode[] = [];
      const inner = tokens.slice(i + 1, end);
      for (let k = 0; k < inner.length; k++) {
        if (inner[k].type === 'inline') itemKids.push(...convertInline(inner[k].children ?? [], ctx));
      }
      items.push(itemKids);
      i = end + 1;
      continue;
    }
    i += 1;
  }
  return { items };
}

/**
 * 收集定义列表的项：一个 dt（术语）后面跟若干 dd（释义）。
 *
 * 内部 token 流是 `dt_open inline dt_close (dd_open inline dd_close)+`，
 * 直接 flatten 会把"哪个释义属于哪个术语"弄丢，所以按 dt 分组。
 */
function collectDefItems(
  tokens: Token[],
  ctx?: ParseContext,
): Array<{ term: InlineNode[]; defs: InlineNode[][] }> {
  const items: Array<{ term: InlineNode[]; defs: InlineNode[][] }> = [];
  let current: { term: InlineNode[]; defs: InlineNode[][] } | null = null;
  let i = 0;
  const inlineOf = (end: number): InlineNode[] => {
    const inline = tokens.slice(i + 1, end).find((tok) => tok.type === 'inline');
    return inline ? convertInline(inline.children ?? [], ctx) : [];
  };
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.type === 'dt_open') {
      const end = findClose(tokens, i, 'dt_open', 'dt_close');
      current = { term: inlineOf(end), defs: [] };
      items.push(current);
      i = end + 1;
      continue;
    }
    if (t.type === 'dd_open' && current) {
      const end = findClose(tokens, i, 'dd_open', 'dd_close');
      current.defs.push(inlineOf(end));
      i = end + 1;
      continue;
    }
    i += 1;
  }
  return items;
}

/** 脚注定义分组：`footnote_open … footnote_close` 一组，meta.id / meta.label 给编号与标记 */
function groupFootnotes(tokens: Token[]): Array<{ id: number; label: string; tokens: Token[] }> {
  const groups: Array<{ id: number; label: string; tokens: Token[] }> = [];
  let i = 0;
  while (i < tokens.length) {
    if (tokens[i].type !== 'footnote_open') {
      i += 1;
      continue;
    }
    const end = findClose(tokens, i, 'footnote_open', 'footnote_close');
    const meta = tokens[i].meta as { id?: number; label?: string } | null;
    groups.push({
      id: typeof meta?.id === 'number' ? meta.id : groups.length,
      label: meta?.label ?? '',
      tokens: tokens.slice(i + 1, end),
    });
    i = end + 1;
  }
  return groups;
}

/** 找与 open 配平的 close（同类 open 计数嵌套） */
function findClose(tokens: Token[], openIdx: number, openType: string, closeType: string): number {
  let depth = 0;
  for (let j = openIdx; j < tokens.length; j++) {
    if (tokens[j].type === openType) depth += 1;
    if (tokens[j].type === closeType) {
      depth -= 1;
      if (depth === 0) return j;
    }
  }
  return tokens.length - 1;
}

function convertTable(
  inner: Token[],
  ctx?: ParseContext,
): Pick<Extract<IRBlock, { type: 'table' }>, 'header' | 'rows' | 'align'> {
  const header: InlineNode[][] = [];
  const rows: InlineNode[][][] = [];
  let inHead = false;
  let curRow: InlineNode[][] | null = null;
  /** 逐列对齐：markdown 的对齐只写在**表头**那一行上（分隔行），一列一个值 */
  const colAlign: Array<'left' | 'center' | 'right' | null> = [];

  for (let i = 0; i < inner.length; i++) {
    const t = inner[i];
    switch (t.type) {
      case 'thead_open':
        inHead = true;
        break;
      case 'thead_close':
        inHead = false;
        break;
      case 'tr_open':
        curRow = [];
        break;
      case 'tr_close':
        if (curRow) {
          if (inHead) header.push(...curRow); // thead 仅一行：单元格即表头
          else rows.push(curRow);
          curRow = null;
        }
        break;
      case 'th_open':
      case 'td_open': {
        const inline = inner[i + 1];
        curRow?.push(inline?.type === 'inline' ? convertInline(inline.children ?? [], ctx) : []);
        if (inHead) colAlign[colAlign.length] = cellAlign(t);
        break;
      }
      default:
        break;
    }
  }
  // header 语义：thead 那一行的各单元格 → header 为单元格数组
  // 整张表都没写对齐时不留 align 键（省一份内存，也避免下游误以为"对齐是空数组"）
  return { header, rows, ...(colAlign.some((a) => a) ? { align: colAlign } : {}) };
}

/** `th_open`/`td_open` 上的 `text-align` → 枚举（只有三种，其余归 null） */
function cellAlign(token: Token): 'left' | 'center' | 'right' | null {
  const style = token.attrGet('style') ?? '';
  const m = /text-align:\s*(left|center|right)/i.exec(style);
  return (m?.[1]?.toLowerCase() as 'left' | 'center' | 'right' | undefined) ?? null;
}

/** markdown-it inline token children → InlineNode 序列 */
export function convertInline(tokens: Token[], ctx?: ParseContext): InlineNode[] {
  const out: InlineNode[] = [];
  let i = 0;

  while (i < tokens.length) {
    const t = tokens[i];
    switch (t.type) {
      case 'text':
        out.push({ type: 'text', text: t.content });
        break;

      case 'code_inline':
        out.push({ type: 'code', text: t.content });
        break;

      case 'strong_open': {
        const end = findCloseInline(tokens, i, 'strong_open', 'strong_close');
        out.push({ type: 'strong', children: convertInline(tokens.slice(i + 1, end), ctx) });
        i = end;
        break;
      }

      case 'em_open': {
        const end = findCloseInline(tokens, i, 'em_open', 'em_close');
        out.push({ type: 'em', children: convertInline(tokens.slice(i + 1, end), ctx) });
        i = end;
        break;
      }

      case 'mark_open': {
        const end = findCloseInline(tokens, i, 'mark_open', 'mark_close');
        out.push({ type: 'mark', children: convertInline(tokens.slice(i + 1, end), ctx) });
        i = end;
        break;
      }

      case 'sub_open': {
        const end = findCloseInline(tokens, i, 'sub_open', 'sub_close');
        out.push({ type: 'sub', children: convertInline(tokens.slice(i + 1, end), ctx) });
        i = end;
        break;
      }

      case 'sup_open': {
        const end = findCloseInline(tokens, i, 'sup_open', 'sup_close');
        out.push({ type: 'sup', children: convertInline(tokens.slice(i + 1, end), ctx) });
        i = end;
        break;
      }

      case 'ruby': {
        // markdown-it-ruby：ruby_open → text → rt_open → text → rt_close → ruby_close
        const end = findCloseInline(tokens, i, 'ruby_open', 'ruby_close');
        const inner = tokens.slice(i + 1, end);
        const rtIdx = inner.findIndex((x) => x.type === 'rt_open');
        const base = convertInline(rtIdx === -1 ? inner : inner.slice(0, rtIdx), ctx);
        const rt = rtIdx === -1 ? [] : convertInline(inner.slice(rtIdx + 1, inner.length - 1), ctx);
        out.push({ type: 'ruby', base, rt });
        i = end;
        break;
      }

      case 'tag':
        out.push({ type: 'tag', text: t.content });
        break;

      case 'colored':
        // `[color:#xxx]文字[/color]`：落成受控 span（不是裸 HTML——产物里不出现
        // 用户可写的标签，只有颜色这一个自由维度）
        out.push({
          type: 'html',
          html: `<span style="color:${String((t.meta as { color?: string })?.color ?? '#000')}">${escapeHtml(t.content)}</span>`,
        });
        break;

      case 'emoji':
        // markdown-it-emoji 把 :sunny: 渲染成 unicode，content 即字符本身
        out.push({ type: 'text', text: t.content });
        break;

      case 's_open': {
        // 删除线不建模为独立节点，降级为 em 语义外的普通文本组
        const end = findCloseInline(tokens, i, 's_open', 's_close');
        out.push(...convertInline(tokens.slice(i + 1, end), ctx));
        i = end;
        break;
      }

      case 'link_open': {
        const end = findCloseInline(tokens, i, 'link_open', 'link_close');
        out.push({
          type: 'link',
          href: attrOf(t, 'href') ?? '',
          children: convertInline(tokens.slice(i + 1, end), ctx),
        });
        i = end;
        break;
      }

      case 'image':
        out.push({ type: 'image', src: attrOf(t, 'src') ?? '', alt: t.content ?? '' });
        break;

      case 'softbreak':
        out.push({ type: 'text', text: '\n' });
        break;

      case 'hardbreak':
        out.push({ type: 'break' });
        break;

      case 'html_inline': {
        // 任务列表：markdown-it-task-lists 把整条正文包成
        // `<label …> 正文 </label>` 的**单个** html_inline token，里面的
        // 强调/emoji/短码一律不解析（整条正文对 markdown-it 是不透明的一坨）。
        // 这里拆开标签重新按 inline 解析一次——否则「- [ ] 主题只写性格 :sparkles:」
        // 的 emoji 就留在原文里。
        const label = /^\s*<label[^>]*>([\s\S]*)<\/label>\s*$/i.exec(t.content);
        if (label) {
          const inner = getMarkdownParser().parseInline(label[1], {});
          out.push(...convertInline(inner[0]?.children ?? [], ctx));
          break;
        }
        // 注音：`html: true` 让 html_inline 规则先于 markdown-it-ruby 的 inline 规则命中，
        // 于是 <ruby> 到达 IR 时是一串 html_inline/text。所以这里自己认一遍，
        // 不然注音会退化成裸标签文本。
        if (/^\s*<ruby\b/i.test(t.content)) {
          const rtStart = tokens.findIndex((x, k) => k > i && /<rt\b/i.test(x.content));
          const rtEnd = tokens.findIndex((x, k) => k > (rtStart === -1 ? i : rtStart) && /<\/rt>/i.test(x.content));
          const rubyEnd = tokens.findIndex((x, k) => k > i && /<\/ruby>/i.test(x.content));
          const base = convertInline(tokens.slice(i + 1, rtStart === -1 ? rubyEnd : rtStart), ctx);
          const rt =
            rtStart !== -1 && rtEnd !== -1 ? convertInline(tokens.slice(rtStart + 1, rtEnd), ctx) : [];
          out.push({ type: 'ruby', base, rt });
          i = rubyEnd === -1 ? i : rubyEnd;
          break;
        }
        out.push({ type: 'html', html: t.content });
        break;
      }

      case 'math_inline':
        out.push({ type: 'formula', tex: t.content, displayMode: false });
        break;

      case 'footnote_ref': {
        // 脚注角标：原来是纯文本 `[1]`，点不动也接不上文末条目
        const id = (t.meta as { id?: number } | undefined)?.id;
        out.push(typeof id === 'number' ? { type: 'footnoteRef', id } : { type: 'text', text: '[?]' });
        break;
      }

      default: {
        // 未建模的行内语法：`~~删除线~~`（token `s`）之类。
        // 老实现直接 break，于是删除线上的文字**整段消失**。
        // 现在：记一笔 + 按 content 降级成文字，作者的内容一定还在。
        note(ctx, t);
        if (t.content) out.push({ type: 'text', text: t.content });
        break;
      }
    }
    i += 1;
  }
  return out;
}

/**
 * GitHub Alert 语法：`> [!NOTE]` / `[!TIP]` / `[!IMPORTANT]` / `[!WARNING]` / `[!CAUTION]`
 * → callout 块（带图标与标题）。
 *
 * 为什么在 IR 层做而不是再写一个 markdown-it 插件：整条渲染链已经是
 * parse → IR → applyTheme（没人渲染 markdown-it 的 HTML 了），放在这里就只有一处作者，
 * 而插件写法会让同一份规则存在两个地方。`[文字](链接 "标题")` 那种带标题的写法
 * 也能落成 callout 标题——但这里只取首行的 `[!X]` 标记，标题文案由 callout 变体决定。
 */
const ALERT_VARIANTS: Record<string, string> = {
  NOTE: 'note',
  TIP: 'tip',
  IMPORTANT: 'info',
  WARNING: 'warning',
  CAUTION: 'danger',
};

export const CALLOUT_TITLES: Record<string, string> = {
  note: '备注',
  tip: '提示',
  info: '要点',
  warning: '注意',
  danger: '警告',
};

/** 整段只有 `[toc]` 时才算目录标记（正文里提到 [toc] 不算） */
function isTocMarker(kids: Token[]): boolean {
  if (kids.length !== 1 || kids[0].type !== 'text') return false;
  return kids[0].content.trim().toLowerCase() === '[toc]';
}

/** `{60% left}` / `{100%}`：图宽与对齐（小红书排版件） */
export /** span 文本转义（颜色块走 html 通道，所以这里要自己挡一次） */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function parseImageSizeSpec(raw: string): { width?: string; align?: 'left' | 'center' | 'right' } | null {
  const m = /\{(\d{1,3})%\s*(left|center|right)?\s*\}/i.exec(raw);
  if (!m) return null;
  const width = `${Math.min(100, Math.max(10, Number(m[1])))}%`;
  const align = (m[2]?.toLowerCase() as 'left' | 'center' | 'right' | undefined) ?? 'center';
  return { width, align };
}

function parseGitHubAlert(inner: Token[], ctx?: ParseContext): { variant: string; blocks: IRBlock[] } | null {
  const first = inner[0];
  if (!first || first.type !== 'paragraph_open') return null;
  const inline = inner[1];
  const kids = inline?.children ?? [];
  if (!kids.length || kids[0].type !== 'text') return null;
  const m = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/.exec(kids[0].content);
  if (!m) return null;
  const variant = ALERT_VARIANTS[m[1]] ?? 'note';
  // 去掉标记后的 inline children 作为首段内容。
  // **就地改而不是 spread**：markdown-it 的 Token 上挂着 attrGet/attrIndex 等原型方法，
  // spread 出来的对象会退化成普通对象，attrGet 一调就炸（这里用不到 attrs 也一样）。
  // token 每次 md.parse 都是新建的，就地改不会污染下一次解析。
  kids[0].content = kids[0].content.slice(m[0].length);
  if (inline) inline.children = kids;
  return { variant, blocks: tokensToIR(inner, ctx) };
}

function findCloseInline(tokens: Token[], openIdx: number, openType: string, closeType: string): number {
  let depth = 0;
  for (let j = openIdx; j < tokens.length; j++) {
    if (tokens[j].type === openType) depth += 1;
    if (tokens[j].type === closeType) {
      depth -= 1;
      if (depth === 0) return j;
    }
  }
  return tokens.length;
}
