import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import type StateCore from 'markdown-it/lib/rules_core/state_core.mjs';
import deflist from 'markdown-it-deflist';
// markdown-it-emoji v3 是纯具名导出（full/light/bare），没有 default
import { full as emojiFull } from 'markdown-it-emoji';
import footnote from 'markdown-it-footnote';
import mark from 'markdown-it-mark';
import rub from 'markdown-it-ruby';
import sub from 'markdown-it-sub';
import sup from 'markdown-it-sup';
import taskLists from 'markdown-it-task-lists';
import katexPlugin from '@traptitech/markdown-it-katex';
import container from 'markdown-it-container';
import toc from 'markdown-it-table-of-contents';
import attrs from 'markdown-it-attrs';


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
  /**
   * **不配 `highlight` 回调**。
   *
   * 高亮的唯一作者是 `theme/apply.ts` 的 `highlightCode()`：IR 只存源码，
   * 渲染期用归一化后的 `block.lang` 同步重跑，再把 hljs-* class 映射成主题
   * styles 的内联颜色（微信清洗器剥 class）。
   *
   * 早先这里也配了一份，解析期先渲染一遍、IR 随后把产物**整个丢掉**——
   * 于是同一件事有两个作者，而只有渲染期那个有效：改这份回调不会有任何可见效果
   * （切片 4 的成对变异第一轮就撞上了：把它退回整串 info，285 条断言全绿）。
   */
  const md = new MarkdownIt({
    html: true,
    linkify: true,
    typographer: false,
  });

  // markdown-it 默认只放行 `data:image/(gif|png|jpeg|webp);`（带分号），
  // `svg+xml` 与逗号写法一律拒绝 —— 排版基线图第一轮就抓到了这张图静默变成
  // 一坨原始 markdown 文本。放行范围见 validateLink 头注。
  md.validateLink = validateLink;

  md.use(footnote);
  md.use(katexPlugin, { throwOnError: false });
  // 中文排版常见件（Phase 2 移植自 WeMD/小红书布局仓的插件矩阵）
  md.use(mark); // ==荧光笔==
  md.use(sub);
  md.use(sup);
  md.use(rub);
  md.use(deflist);
  md.use(emojiFull);
  // 任务列表：开 enabled 后产出 `<input type="checkbox">`，而**微信清洗器会吃掉 input**，
  // 所以紧跟着把 checkbox token 换成 ✅/⬜ 文本（见 checkboxToEmoji 核心规则）
  md.use(taskLists, { enabled: true, label: true, labelAfter: true });
  // push 到链尾而不是 after('inline')：task-lists 自己也注册了 core 规则并在后面
  // 重排 inline children，挂在 inline 之后会被它重新吐回 <input>
  md.use(toc, { includeLevel: [1, 2, 3] });
  md.use(attrs);
  for (const variant of CALLOUT_VARIANTS) {
    md.use(container, variant);
  }

  md.core.ruler.push('mdcore_checkbox_to_emoji', checkboxToEmoji);
  // 中文/小红书行内扩展：必须在 emoji 之后（`:名:` 先被 emoji 吃掉，
  // `#话题` 里不会有冒号，互不打架）
  md.core.ruler.push('mdcore_inline_ext', inlineExtensions);
  return md;
}

/**
 * `<input type="checkbox">` → `✅ ` / `⬜ `。
 *
 * 为什么必须转：微信编辑器把 `<input>` 整类标签清洗掉，任务列表在公众号里就变成
 * 四个没有勾选框的行。换成 emoji 后三个平台都能看见（参考实现 WeMD 的
 * `markdown-it-checkbox-emoji`，思路一致、代码本仓库自写）。
 */
function checkboxToEmoji(state: StateCore): void {
  const visit = (tokens: Token[]): void => {
    for (const token of tokens) {
      // html_inline 是**inline token 的子节点**，只看顶层 token 永远扫不到
      if (token.children) visit(token.children);
      if (token.type !== 'html_inline') continue;
      if (!/^\s*<input\b/i.test(token.content)) continue;
      const checked = /\bchecked\b/i.test(token.content);
      token.type = 'text';
      token.content = checked ? '✅ ' : '⬜ ';
    }
  };
  visit(state.tokens);
}

/**
 * 行内扩展核心规则：`#话题` 与 `[color:#xxx]文字[/color]`。
 *
 * 为什么用核心规则而不是 IR 层：这两个都要在**文本 token 内部**切段（`今天聊 #AI 与
 * #设计` 一段文字里有几个话题），而 IR 层的 inline 是整块转换的，做不了切分。
 * 切出来的 token 交给 IR 建模（tag / html），渲染与清洗规则仍然只有一处。
 *
 * 判据：话题前后必须是非标签字符（否则 `C#` 这种会误伤），且不以 `#` 开头
 * 连续（那已经是标题语法，不会走到 inline text 里）。
 */
const TAG_RE = /(^|[^\w&])#([\w\u4e00-\u9fa5]{1,20})(?![\w\u4e00-\u9fa5])/g;
const COLOR_RE = /\[color:#([0-9a-fA-F]{3,8})\]([^\[\]]*)\[\/color\]/g;

function inlineExtensions(state: StateCore): void {
  for (const token of state.tokens) {
    if (token.type !== 'inline' || !token.children) continue;
    token.children = token.children.flatMap((child) => {
      if (child.type !== 'text') return [child];
      const out: Token[] = [];
      let rest = child.content;
      // 两种语法各自扫一遍：先彩色文字（带定界符，优先），再话题
      const cuts: Array<{ start: number; end: number; node: Token }> = [];
      for (const m of rest.matchAll(COLOR_RE)) {
        const node = new state.Token('colored', '', 0);
        node.content = m[2];
        node.meta = { color: `#${m[1]}` };
        cuts.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, node });
      }
      for (const m of rest.matchAll(TAG_RE)) {
        const start = (m.index ?? 0) + m[1].length;
        const node = new state.Token('tag', '', 0);
        node.content = m[2];
        cuts.push({ start, end: (m.index ?? 0) + m[0].length, node });
      }
      cuts.sort((a, b) => a.start - b.start);
      let cursor = 0;
      for (const cut of cuts) {
        if (cut.start < cursor) continue; // 重叠（不该发生）时先到先得
        if (cut.start > cursor) {
          const text = new state.Token('text', '', 0);
          text.content = rest.slice(cursor, cut.start);
          out.push(text);
        }
        out.push(cut.node);
        cursor = cut.end;
      }
      if (!cuts.length) return [child];
      if (cursor < rest.length) {
        const text = new state.Token('text', '', 0);
        text.content = rest.slice(cursor);
        out.push(text);
      }
      return out;
    });
  }
}

let shared: MarkdownIt | null = null;

/** 共享解析器实例（markdown-it 实例可复用） */
export function getMarkdownParser(): MarkdownIt {
  if (!shared) shared = createMarkdownParser();
  return shared;
}
