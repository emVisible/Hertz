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
  /** `#话题`：小红书发布时的话题标签（导出文案与正文里都认） */
  | { type: 'tag'; text: string }
  /** 脚注角标 `[^1]`：渲染成上标数字，可回跳文末对应条目 */
  | { type: 'footnoteRef'; id: number }
  | { type: 'code'; text: string }
  | { type: 'link'; href: string; children: InlineNode[] }
  /**
   * 行内图片。`width/align` 与块级图同一套 `{60% left}` 记号——
   * 段内插图此前连这两个字段都没有，写了 `{60% left}` 也不起作用。
   */
  | { type: 'image'; src: string; alt: string; width?: string; align?: 'left' | 'center' | 'right' }
  | { type: 'formula'; tex: string; displayMode: boolean }
  /** 原生 HTML inline（兜底通道，katex/脚注等暂不建模的渲染产物） */
  | { type: 'html'; html: string }
  | { type: 'break' };

export type IRBlock =
  | { type: 'heading'; level: number; children: InlineNode[]; line: LineRange | null }
  | { type: 'para'; children: InlineNode[]; line: LineRange | null }
  | { type: 'list'; ordered: boolean; items: InlineNode[][]; line: LineRange | null }
  | {
      type: 'code';
      /** 归一化后的语言（高亮用），`null` = 没写或无法识别 */
      lang: string | null;
      /** 代码头部的可读标签（文件名优先，其次语言名） */
      label?: string;
      code: string;
      line: LineRange | null;
    }
  | {
      type: 'table';
      header: InlineNode[][];
      rows: InlineNode[][][];
      /**
       * 逐列对齐（长度 = 列数，缺省 null = 跟随主题的 th/td 默认值）。
       *
       * 为什么必须进 IR：markdown-it 把 `:---:` / `---:` 放在 `th_open`/`td_open`
       * 的 style 属性上，而早先的 convertTable **只取 inline children**，style
       * 整个被丢掉；随后样式槽又硬写 `text-align: left`——于是 `|:---:|` 在产物里
       * 恒为左对齐，数值列对不齐。
       *
       * 按**列**而不是按格：markdown 表格的对齐只由表头下的分隔行决定，一列一个值，
       * 作用于该列所有单元格。做成二维表是凭空多出一层不存在的数据。
       */
      align?: Array<'left' | 'center' | 'right' | null>;
      line: LineRange | null;
    }
  | { type: 'quote'; blocks: IRBlock[]; line: LineRange | null }
  | {
      type: 'image';
      src: string;
      alt: string;
      /** `{60% left}` 覆盖图宽与对齐（小红书排版件） */
      width?: string;
      align?: 'left' | 'center' | 'right';
      line: LineRange | null;
    }
  | { type: 'callout'; variant: string; blocks: IRBlock[]; line: LineRange | null }
  | { type: 'formula'; tex: string; displayMode: boolean; line: LineRange | null }
  /**
   * 横线。`kind` 区分两种写法，因为它们的**意图**不同：
   * - `rule`（`***` / `___`）：一条分隔线，三个平台都画出来；
   * - `pagebreak`（`---`）：小红书/公众号的"换页"意图。小红书卡成图，
   *   画一条线没有意义，所以在那里被翻成强制分页；微信/知乎是连续长文，
   *   同一行仍然画成分隔线（不能为了卡片平台改掉长文的既有行为）。
   */
  | { type: 'hr'; kind: 'rule' | 'pagebreak'; line: LineRange | null }
  /** `[toc]`：目录块，条目来自文档的 2/3 级标题（anchor 可跳） */
  | { type: 'toc'; items: Array<{ level: number; text: string; anchor: string }>; line: LineRange | null }
  /** 定义列表 `术语\n: 释义`：一个术语可带多条释义 */
  | {
      type: 'deflist';
      items: Array<{ term: InlineNode[]; defs: InlineNode[][] }>;
      line: LineRange | null;
    }
  /**
   * 文末脚注区（`[^1]: 正文`）。
   *
   * 之前整块被跳掉，脚注正文一个字都不剩——语法守卫第一次跑就报出来了。
   * 现在按区建模：正文里的角标是 `footnoteRef`，这里是被引用的内容。
   */
  | {
      type: 'footnotes';
      items: Array<{ id: number; label: string; blocks: IRBlock[] }>;
      line: LineRange | null;
    };

export type IRBlockType = IRBlock['type'];

/** LayoutIR = 顶层块序列 */
export type LayoutIR = IRBlock[];

/**
 * 未建模语法的记账项（Phase 5 守卫）。
 *
 * 为什么要有它：解析层遇到不认识的 token 只能二选一——丢，或者原样带出来。
 * 早先选的是「丢」（`default: i += 1`），于是 `~~删除线~~`、定义列表、脚注正文
 * 会在成品里**整段消失**，而 190 条结构断言一条都不红：它们压根不知道有这个语法。
 * 现在改成「保内容 + 记账」：`parseToIRDetailed()` 给出清单，由判据守住
 * 「未覆盖集合为空」。
 */
export interface IRDiagnostic {
  /** markdown-it token 类型，如 `dl_open` / `s` / `footnote_def` */
  token: string;
  /** 出现次数（同一语法在一篇里出现多次只记一条） */
  count: number;
  /** 首次出现的源码行（0 起），便于定位 */
  line: number | null;
}
