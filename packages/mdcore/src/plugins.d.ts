// 无官方类型包的 markdown-it 插件的极简声明（仅用到插件函数签名）
declare module 'markdown-it-footnote' {
  import type MarkdownIt from 'markdown-it';
  const plugin: (md: MarkdownIt) => void;
  export default plugin;
}

declare module 'markdown-it-container' {
  import type MarkdownIt from 'markdown-it';
  interface ContainerOptions {
    validate?: (params: string, markup: string) => boolean;
    render?: (tokens: unknown[], idx: number) => string;
    marker?: string;
  }
  const plugin: (md: MarkdownIt, name: string, options?: ContainerOptions) => void;
  export default plugin;
}

declare module 'markdown-it-table-of-contents' {
  import type MarkdownIt from 'markdown-it';
  interface TocOptions {
    includeLevel?: number[];
    containerHeaderHtml?: string;
    markerPattern?: RegExp;
    listType?: string;
    format?: (heading: string) => string;
  }
  const plugin: (md: MarkdownIt, options?: TocOptions) => void;
  export default plugin;
}

declare module 'markdown-it-attrs' {
  import type MarkdownIt from 'markdown-it';
  interface AttrsOptions {
    leftDelimiter?: string;
    rightDelimiter?: string;
    allowedAttributes?: Array<string | RegExp>;
    span?: boolean;
  }
  const plugin: (md: MarkdownIt, options?: AttrsOptions) => void;
  export default plugin;
}

/* ---- Phase 2：中文排版常见件的极简声明（皆无官方类型包） ---- */

declare module 'markdown-it-mark' {
  import type MarkdownIt from 'markdown-it';
  const plugin: (md: MarkdownIt) => void;
  export default plugin;
}

declare module 'markdown-it-sub' {
  import type MarkdownIt from 'markdown-it';
  const plugin: (md: MarkdownIt) => void;
  export default plugin;
}

declare module 'markdown-it-sup' {
  import type MarkdownIt from 'markdown-it';
  const plugin: (md: MarkdownIt) => void;
  export default plugin;
}

declare module 'markdown-it-ruby' {
  import type MarkdownIt from 'markdown-it';
  const plugin: (md: MarkdownIt) => void;
  export default plugin;
}

declare module 'markdown-it-deflist' {
  import type MarkdownIt from 'markdown-it';
  const plugin: (md: MarkdownIt) => void;
  export default plugin;
}

declare module 'markdown-it-emoji' {
  import type MarkdownIt from 'markdown-it';
  /** v3 纯具名导出（没有 default）：light 短码少、full 全量、bare 无变体 */
  const light: (md: MarkdownIt) => void;
  const full: (md: MarkdownIt) => void;
  const bare: (md: MarkdownIt) => void;
}

declare module 'markdown-it-task-lists' {
  import type MarkdownIt from 'markdown-it';
  interface TaskListsOptions {
    enabled?: boolean;
    label?: boolean;
    labelAfter?: boolean;
  }
  const plugin: (md: MarkdownIt, options?: TaskListsOptions) => void;
  export default plugin;
}
