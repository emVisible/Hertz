/**
 * Shiki 二次 pass（P1-3 / v0.37）：把同步 hljs 的初版高亮升级为 Shiki 的 token 精度。
 *
 * ## 为什么是"二次 pass"而不是换掉 hljs
 *
 * markdown-it 的 highlight 回调是同步签名，Shiki 只提供异步 API（见
 * `parse/markdown.ts` 头注：当初选定 hljs 时就写明"留给后续导出质量优化"）。
 * 于是渲染管线保持原样：`applyTheme()` 同步产出 DOM，`highlightCode()`
 * 同步跑一遍 hljs——**这一版永远先在**，用户立刻看到东西。
 * 然后本模块异步把 hljs 的 class 产物升级成 Shiki 的内联色。
 *
 * ## 为什么必须"内联色"而不是 class
 *
 * 微信/知乎清洗器剥 `class` 与 `<style>`（`platform/inline.ts:stripUnsafe`），
 * 只认写在节点上的 style。Shiki 的 `structure: 'inline'` 输出正好是
 * `<span style="color:#D73A49">…</span>`：它落成内联样式，与 hljs 路径
 * 把 token 色映射成内联色是同一件事，不需要第二套落地逻辑。
 *
 * ## 失败语义
 *
 * Shiki 拿不到语言、装载失败、或高亮抛错 → **保留 hljs 的产物**，
 * 一次高亮都不会白做。诊断横幅不记这条：内容仍然是被高亮的（降级到了
 * 上一版引擎），把"引擎换了"报成"我们没支持"是虚惊。
 * 同理，装载失败也不外抛——它会让导出/复制整条路挂掉，而产物其实完好。
 *
 * ## 判据的形状
 *
 * 本模块只认 DOM 上的 `data-mdcore-lang` 标记（由 `apply.ts` 写），
 * 高亮器与主题名都可注入——这样 jsdom 测试能注入可挂起的假高亮器，
 * 验"中间态"（渲染完、升级未落）与"引擎挂了仍保留 hljs 产物"。
 * 真实的 Shiki 产物质量交给排版基线图判（逐像素比对 + 成对变异）。
 */
import { resolveTokens } from './types';
import type { CodeThemeId, Theme, ThemeOverrides } from './types';
import { getTheme } from './index';

/**
 * 代码块的「语言标记」：Shiki 二次 pass 的发现通道。
 *
 * 挂在 `<code>` 上（不是 `<pre>`），因为行内代码也会生成 `<code>`——
 * 只有块级代码带这个标记，pass 因此天然只动代码块。
 * `data-mdcore-*` 会被 `stripUnsafe` 剥掉，不进平台产物（与块定位标记同族）。
 */
export const CODE_LANG_ATTR = 'data-mdcore-lang';

/** 高亮器：源码 + 语言 + Shiki 主题名 → 内联色 HTML；返回 null 表示"不接管" */
export type CodeHighlighter = (
  code: string,
  lang: string,
  themeName: string,
) => Promise<string | null>;

/**
 * 宿主与测试可替换引擎的通道（全局而非模块级单例）。
 *
 * 之所以不用模块级变量：前端测试里 `vi.mock('@hertz/mdcore')` **拦不住
 * 页面内部的调用**（workspace 源码包的身份问题，handover §4 有记录），
 * 模块级注入会在"页面里调的那个实例"上落空。挂 `globalThis` 是唯一跨模块
 * 实例都认的通道。产品代码不设置它——生产走下面的默认 Shiki。
 */
type EngineRegistry = {
  __mdcoreCodeHighlighter?: CodeHighlighter;
};

function registry(): EngineRegistry {
  return globalThis as unknown as EngineRegistry;
}

/** 注入高亮器（测试/宿主替换用）；传 null 恢复默认 Shiki */
export function setCodeHighlighter(highlighter: CodeHighlighter | null): void {
  const r = registry();
  if (highlighter) r.__mdcoreCodeHighlighter = highlighter;
  else delete r.__mdcoreCodeHighlighter;
}

/** 代码高亮预设（P1-5：此前只有两套写死字典，用户无从选择）。常量表见 types.ts */
export { CODE_THEMES } from './types';

/**
 * 预设 → Shiki 浅深两版主题。
 *
 * `auto` 就是原 hljs 字典的口径（GitHub Light/Dark），所以**默认这一版
 * 与既有配色同源**——切到 Shiki 之后首屏观感不变，基线图的差异只来自
 * token 精度，不来自"换了个配色"。单色主题（dracula/nord）浅深同版。
 */
const CODE_THEME_SHIKI: Record<CodeThemeId, { light: string; dark: string }> = {
  auto: { light: 'github-light', dark: 'github-dark' },
  github: { light: 'github-light', dark: 'github-dark' },
  vitesse: { light: 'vitesse-light', dark: 'vitesse-dark' },
  catppuccin: { light: 'catppuccin-latte', dark: 'catppuccin-mocha' },
  dracula: { light: 'dracula', dark: 'dracula' },
  nord: { light: 'nord', dark: 'nord' },
  'one-dark': { light: 'one-light', dark: 'one-dark-pro' },
};

/** 代码高亮预设 id → Shiki 主题名（未知值退回 auto，不静默崩） */
export function resolveCodeThemeName(id: string | undefined | null, isDark: boolean): string {
  const table = CODE_THEME_SHIKI as Record<string, { light: string; dark: string }>;
  const preset = (id ? table[id] : undefined) ?? table.auto;
  return isDark ? preset.dark : preset.light;
}

/**
 * 主题 + overrides + 深浅 → Shiki 主题名。
 *
 * 深浅以主题自身的 `dark` 标记为准；预览的深色开关是宿主换主题（`darkThemeFor`），
 * 传进来的主题已经是深色款，所以这里不需要额外参数。
 */
export function codeThemeNameFor(
  theme: Theme | string,
  overrides: ThemeOverrides = {},
  isDark?: boolean,
): string {
  const resolved = typeof theme === 'string' ? getTheme(theme) : theme;
  const tokens = resolveTokens(resolved, overrides);
  return resolveCodeThemeName(tokens.codeTheme, isDark ?? !!resolved.dark);
}

/** hljs 语言名 → Shiki 语言 id（只登记两边命名确实不同的那几个） */
const SHIKI_LANG: Record<string, string> = {
  objectivec: 'objective-c',
  vbnet: 'vb',
};

/** 归一化语言标记 → Shiki 语言 id；`null` = 这块 Shiki 不接管 */
export function shikiLangOf(lang: string | null | undefined): string | null {
  if (!lang) return null;
  const key = lang.trim().toLowerCase();
  if (!key) return null;
  return SHIKI_LANG[key] ?? key;
}

let defaultHighlighter: Promise<CodeHighlighter> | null = null;

async function shikiHighlighter(): Promise<CodeHighlighter> {
  if (!defaultHighlighter) {
    defaultHighlighter = import('./shikiRuntime')
      .then(({ runtimeHighlighter }) => runtimeHighlighter())
      .then((highlighter) => {
        const loaded = new Set(highlighter.getLoadedLanguages());
        return async (code: string, lang: string, themeName: string): Promise<string | null> => {
          if (!loaded.has(lang)) return null;
          try {
            return highlighter.codeToHtml(code, {
              lang,
              theme: themeName,
              // 只取行内 span：<pre>/<code> 外壳是我们自己的（主题的 codeBg/圆角/内距）
              structure: 'inline',
            });
          } catch {
            return null;
          }
        };
      })
      .catch((e) => {
        defaultHighlighter = null;
        throw e;
      });
  }
  return defaultHighlighter;
}

export interface HighlightCodeOptions {
  /** 注入式高亮器；`null` = 明确不做二次 pass；不给走默认 Shiki */
  highlighter?: CodeHighlighter | null;
  /** Shiki 主题名（一般由 `codeThemeNameFor()` 算好传进来） */
  themeName?: string;
}

/**
 * 把渲染态 DOM 里的代码块升级为 Shiki 内联色高亮。
 *
 * 返回实际升级的块数。**不改入参之外的东西**：`code.innerHTML` 原地替换，
 * 块尺寸不变（同一份文本、同一套字体/行高，只有 span 多了一层），
 * 所以分页结果与画布排版都不需要因为这一次升级而重算。
 */
export async function highlightCodeBlocks(
  root: ParentNode,
  opts: HighlightCodeOptions = {},
): Promise<number> {
  const codes = Array.from(root.querySelectorAll(`code[${CODE_LANG_ATTR}]`));
  if (!codes.length) return 0;
  const highlighter =
    opts.highlighter === null
      ? null
      : (opts.highlighter ??
        registry().__mdcoreCodeHighlighter ??
        (await shikiHighlighter().catch(() => null)));
  if (!highlighter) return 0;
  const themeName = opts.themeName ?? resolveCodeThemeName('auto', false);

  let upgraded = 0;
  for (const el of codes) {
    const lang = shikiLangOf(el.getAttribute(CODE_LANG_ATTR));
    if (!lang) continue;
    let html: string | null = null;
    try {
      html = await highlighter(el.textContent ?? '', lang, themeName);
    } catch {
      // 单块失败不外溢：hljs 的产物原样留着（它就是"保底高亮"），
      // 一次失败不该让整篇稿子的导出/复制全挂掉。
      html = null;
    }
    // null = 这块不接管（语言不在包里 / 高亮抛错）→ 保留 hljs 的产物
    if (html === null) continue;
    el.innerHTML = html;
    upgraded += 1;
  }
  return upgraded;
}