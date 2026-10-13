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
