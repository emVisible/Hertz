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
 * markdown-it 默认禁掉的协议。
 *
 * `data:` **必须留在这里**：它是"默认拒、逐条放行"的族。只把它移出去写成
 * "见下方白名单"，白名单之外的 data: 地址就变成默认放行——`data:text/html` 会
 * 直接变链接（我第一版就写错了这条，被自己的断言当场抓住）。
 */
const BAD_PROTO_RE = /^(vbscript|javascript|file|data):/i;

/**
 * 放行的内联图片 data URL。
 *
 * markdown-it 默认把 `data:` 整族禁掉（防 `data:text/html` 的 XSS），代价是
 * **内联 SVG/占位图会静默变成一坨原始 markdown 文本**——排版基线图第一轮就抓到了
 * 这个：一张 data:image/svg+xml 的配图在画布上打印成了整行 URL。
 *
 * 放行范围刻意窄到「图片」：只认 `data:image/<子类型>`，而 `<img src>` 里的 SVG
 * 不执行脚本（浏览器对 img 加载的 SVG 禁用 script），`data:text/html` 之类仍然被拒。
 */
const SAFE_IMAGE_DATA_RE = /^data:image\/(png|jpe?g|gif|webp|svg\+xml|bmp|avif)[;,]/i;

function validateLink(url: string): boolean {
  const str = url.trim();
  if (SAFE_IMAGE_DATA_RE.test(str)) return true;
  return !BAD_PROTO_RE.test(str.toLowerCase());
}

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

  // markdown-it 默认只放行 `data:image/(gif|png|jpeg|webp);`（带分号），
  // `svg+xml` 与逗号写法一律拒绝 —— 排版基线图第一轮就抓到了这张图静默变成
  // 一坨原始 markdown 文本。放行范围见 validateLink 头注。
  md.validateLink = validateLink;

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
