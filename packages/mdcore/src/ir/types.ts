/**
 * LayoutIR（§2 ir/）—— 心脏层。
 * 平台适配与分页只认 IR，不认 markdown-it token。
 * IR 是后续所有环节（theme / paginate / platform / export）的唯一输入。
 */

/** 源码行号区间：直接沿用 markdown-it token.map（0 起、end 开区间）。嵌套子块无独立行号时为 null。 */
export type LineRange = [number, number];

export type InlineNode =
  | { type: 'text'; text: string }
  | { type: 'strong'; children: InlineNode[] }
  | { type: 'em'; children: InlineNode[] }
  /** `==荧光笔==`：小红书/公众号正文里最常见的强调写法（中文排版里比 font-weight 更地道） */
  | { type: 'mark'; children: InlineNode[] }
  /** `H~2~O` / `E=mc^2^` */
  | { type: 'sub'; children: InlineNode[] }
  | { type: 'sup'; children: InlineNode[] }
  /** `<ruby>注音<rt>zhùyīn</rt></ruby>` */
  | { type: 'ruby'; base: InlineNode[]; rt: InlineNode[] }
  | { type: 'code'; text: string }
  | { type: 'link'; href: string; children: InlineNode[] }
  | { type: 'image'; src: string; alt: string }
  | { type: 'formula'; tex: string; displayMode: boolean }
  /** 原生 HTML inline（兜底通道，katex/脚注等暂不建模的渲染产物） */
  | { type: 'html'; html: string }
  | { type: 'break' };

export type IRBlock =
  | { type: 'heading'; level: number; children: InlineNode[]; line: LineRange | null }
  | { type: 'para'; children: InlineNode[]; line: LineRange | null }
  | { type: 'list'; ordered: boolean; items: InlineNode[][]; line: LineRange | null }
  | { type: 'code'; lang: string | null; code: string; line: LineRange | null }
  | { type: 'table'; header: InlineNode[][]; rows: InlineNode[][][]; line: LineRange | null }
  | { type: 'quote'; blocks: IRBlock[]; line: LineRange | null }
  | { type: 'image'; src: string; alt: string; line: LineRange | null }
  | { type: 'callout'; variant: string; blocks: IRBlock[]; line: LineRange | null }
  | { type: 'formula'; tex: string; displayMode: boolean; line: LineRange | null }
  | { type: 'hr'; line: LineRange | null };

export type IRBlockType = IRBlock['type'];

/** LayoutIR = 顶层块序列 */
export type LayoutIR = IRBlock[];
