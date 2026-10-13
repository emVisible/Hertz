import MarkdownIt from 'markdown-it';
import footnote from 'markdown-it-footnote';
import katexPlugin from '@traptitech/markdown-it-katex';
import container from 'markdown-it-container';
import toc from 'markdown-it-table-of-contents';
import attrs from 'markdown-it-attrs';
import hljs from 'highlight.js';

/** markdown-it-container 注册的 callout 变体（:::note / :::warning ...） */
export const CALLOUT_VARIANTS = ['note', 'tip', 'warning', 'danger', 'info', 'callout'] as const;

/**
 * markdown-it 工厂（§2 parse/）。
 * 插件：footnote / katex(@traptitech) / container(callout) / toc / attrs。
 *
 * 代码高亮：选 highlight.js 同步方案而非 shiki。
 * 理由：markdown-it 的 highlight 回调是同步签名，shiki 只提供异步 API，
 * 若接入需 render 后异步二次 pass，会让 parse→IR→渲染 的同步管线分叉；
 * 切片 A 求稳用 hljs（高亮 token 在 theme 层映射为内联颜色，微信清洗器不丢）。
 * shiki 异步二次 pass 留给后续导出质量优化。
 */
export function createMarkdownParser(): MarkdownIt {
  const md = new MarkdownIt({
    html: true,
    linkify: true,
    typographer: false,
    highlight(code: string, lang: string): string {
      if (lang && hljs.getLanguage(lang)) {
        try {
          return hljs.highlight(code, { language: lang }).value;
        } catch {
          // 未知/损坏语法高亮失败时降级为纯文本转义（返回 '' 走默认）
        }
      }
      return '';
    },
  });

  md.use(footnote);
  md.use(katexPlugin, { throwOnError: false });
  md.use(toc, { includeLevel: [1, 2, 3] });
  md.use(attrs);
  for (const variant of CALLOUT_VARIANTS) {
    md.use(container, variant);
  }
  return md;
}

let shared: MarkdownIt | null = null;

/** 共享解析器实例（markdown-it 实例可复用） */
export function getMarkdownParser(): MarkdownIt {
  if (!shared) shared = createMarkdownParser();
  return shared;
}
