import type Token from 'markdown-it/lib/token.mjs';
import { getMarkdownParser } from '../parse/markdown';
import type { IRBlock, InlineNode, LayoutIR, LineRange } from './types';

/** markdown 字符串 → LayoutIR（§2：parse → IR 是唯一下游输入） */
export function parseToIR(markdown: string): LayoutIR {
  const md = getMarkdownParser();
  const tokens = md.parse(markdown, {});
  return tokensToIR(tokens);
}

function lineOf(token: Token): LineRange | null {
  return token.map ? [token.map[0], token.map[1]] : null;
}

function attrOf(token: Token, name: string): string | null {
  return token.attrGet(name);
}

/** markdown-it token stream → LayoutIR 块序列 */
export function tokensToIR(tokens: Token[]): IRBlock[] {
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
        blocks: tokensToIR(tokens.slice(i + 1, end)),
        line: lineOf(t),
      });
      i = end + 1;
      continue;
    }

    switch (t.type) {
      case 'heading_open': {
        const inline = tokens[i + 1];
        blocks.push({
          type: 'heading',
          level: Number(t.tag.slice(1)),
          children: convertInline(inline?.children ?? []),
          line: lineOf(t),
        });
        i += 3;
        break;
      }

      case 'paragraph_open': {
        const inline = tokens[i + 1];
        const kids = inline?.children ?? [];
        // 独立段落里的单张图提升为 image 块
        if (kids.length === 1 && kids[0].type === 'image') {
          blocks.push({
            type: 'image',
            src: attrOf(kids[0], 'src') ?? '',
            alt: kids[0].content ?? '',
            line: lineOf(t),
          });
        } else {
          blocks.push({ type: 'para', children: convertInline(kids), line: lineOf(t) });
        }
        i += 3;
        break;
      }

      case 'bullet_list_open':
      case 'ordered_list_open': {
        const ordered = t.type === 'ordered_list_open';
        const closeType = ordered ? 'ordered_list_close' : 'bullet_list_close';
        const items: InlineNode[][] = [];
        let j = i + 1;
        while (j < tokens.length && tokens[j].type !== closeType) {
          if (tokens[j].type === 'list_item_open') {
            const itemKids: InlineNode[] = [];
            j += 1;
            // 简化：item 内所有 inline 内容并入一条（嵌套块在切片 A 不展开）
            while (j < tokens.length && tokens[j].type !== 'list_item_close') {
              if (tokens[j].type === 'inline') {
                itemKids.push(...convertInline(tokens[j].children ?? []));
              }
              j += 1;
            }
            items.push(itemKids);
          }
          j += 1;
        }
        blocks.push({ type: 'list', ordered, items, line: lineOf(t) });
        i = j + 1;
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
        blocks.push({ type: 'table', ...convertTable(tokens.slice(i + 1, end)), line: lineOf(t) });
        i = end + 1;
        break;
      }

      case 'blockquote_open': {
        const end = findClose(tokens, i, 'blockquote_open', 'blockquote_close');
        const inner = tokens.slice(i + 1, end);
        const alert = parseGitHubAlert(inner);
        if (alert) {
          blocks.push({ type: 'callout', ...alert, line: lineOf(t) });
        } else {
          blocks.push({ type: 'quote', blocks: tokensToIR(inner), line: lineOf(t) });
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
        blocks.push({ type: 'hr', line: lineOf(t) });
        i += 1;
        break;
      }

      case 'html_block': {
        blocks.push({ type: 'para', children: [{ type: 'html', html: t.content }], line: lineOf(t) });
        i += 1;
        break;
      }

      case 'inline': {
        blocks.push({ type: 'para', children: convertInline(t.children ?? []), line: lineOf(t) });
        i += 1;
        break;
      }

      case 'footnote_block_open': {
        // 脚注定义区不建块（引用点已在 inline 内转为文本角标）
        const end = findClose(tokens, i, 'footnote_block_open', 'footnote_block_close');
        i = end + 1;
        break;
      }

      default:
        i += 1;
    }
  }
  return blocks;
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

function convertTable(inner: Token[]): Pick<Extract<IRBlock, { type: 'table' }>, 'header' | 'rows'> {
  const header: InlineNode[][] = [];
  const rows: InlineNode[][][] = [];
  let inHead = false;
  let curRow: InlineNode[][] | null = null;

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
        curRow?.push(inline?.type === 'inline' ? convertInline(inline.children ?? []) : []);
        break;
      }
      default:
        break;
    }
  }
  // header 语义：thead 那一行的各单元格 → header 为单元格数组
  return { header, rows };
}

/** markdown-it inline token children → InlineNode 序列 */
export function convertInline(tokens: Token[]): InlineNode[] {
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
        out.push({ type: 'strong', children: convertInline(tokens.slice(i + 1, end)) });
        i = end;
        break;
      }

      case 'em_open': {
        const end = findCloseInline(tokens, i, 'em_open', 'em_close');
        out.push({ type: 'em', children: convertInline(tokens.slice(i + 1, end)) });
        i = end;
        break;
      }

      case 'mark_open': {
        const end = findCloseInline(tokens, i, 'mark_open', 'mark_close');
        out.push({ type: 'mark', children: convertInline(tokens.slice(i + 1, end)) });
        i = end;
        break;
      }

      case 'sub_open': {
        const end = findCloseInline(tokens, i, 'sub_open', 'sub_close');
        out.push({ type: 'sub', children: convertInline(tokens.slice(i + 1, end)) });
        i = end;
        break;
      }

      case 'sup_open': {
        const end = findCloseInline(tokens, i, 'sup_open', 'sup_close');
        out.push({ type: 'sup', children: convertInline(tokens.slice(i + 1, end)) });
        i = end;
        break;
      }

      case 'ruby': {
        // markdown-it-ruby：ruby_open → text → rt_open → text → rt_close → ruby_close
        const end = findCloseInline(tokens, i, 'ruby_open', 'ruby_close');
        const inner = tokens.slice(i + 1, end);
        const rtIdx = inner.findIndex((x) => x.type === 'rt_open');
        const base = convertInline(rtIdx === -1 ? inner : inner.slice(0, rtIdx));
        const rt = rtIdx === -1 ? [] : convertInline(inner.slice(rtIdx + 1, inner.length - 1));
        out.push({ type: 'ruby', base, rt });
        i = end;
        break;
      }

      case 'emoji':
        // markdown-it-emoji 把 :sunny: 渲染成 unicode，content 即字符本身
        out.push({ type: 'text', text: t.content });
        break;

      case 's_open': {
        // 删除线不建模为独立节点，降级为 em 语义外的普通文本组
        const end = findCloseInline(tokens, i, 's_open', 's_close');
        out.push(...convertInline(tokens.slice(i + 1, end)));
        i = end;
        break;
      }

      case 'link_open': {
        const end = findCloseInline(tokens, i, 'link_open', 'link_close');
        out.push({
          type: 'link',
          href: attrOf(t, 'href') ?? '',
          children: convertInline(tokens.slice(i + 1, end)),
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
          out.push(...convertInline(inner[0]?.children ?? []));
          break;
        }
        // 注音：`html: true` 让 html_inline 规则先于 markdown-it-ruby 的 inline 规则命中，
        // 于是 <ruby> 到达 IR 时是一串 html_inline/text。所以这里自己认一遍，
        // 不然注音会退化成裸标签文本。
        if (/^\s*<ruby\b/i.test(t.content)) {
          const rtStart = tokens.findIndex((x, k) => k > i && /<rt\b/i.test(x.content));
          const rtEnd = tokens.findIndex((x, k) => k > (rtStart === -1 ? i : rtStart) && /<\/rt>/i.test(x.content));
          const rubyEnd = tokens.findIndex((x, k) => k > i && /<\/ruby>/i.test(x.content));
          const base = convertInline(tokens.slice(i + 1, rtStart === -1 ? rubyEnd : rtStart));
          const rt =
            rtStart !== -1 && rtEnd !== -1 ? convertInline(tokens.slice(rtStart + 1, rtEnd)) : [];
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
        const id = (t.meta as { id?: number } | undefined)?.id;
        out.push({ type: 'text', text: `[${typeof id === 'number' ? id + 1 : '?'}]` });
        break;
      }

      default:
        // emoji 等已渲染为 text；其余暂不建模的 inline 直接跳过
        break;
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

function parseGitHubAlert(inner: Token[]): { variant: string; blocks: IRBlock[] } | null {
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
  return { variant, blocks: tokensToIR(inner) };
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
