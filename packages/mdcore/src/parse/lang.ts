/**
 * 围栏语言串的解析与归一化（W1 切片 4）。
 *
 * 此前 `t.info.trim()` 整串拿走，于是：
 * - ` ```ts title="a.ts" ` → `hljs.getLanguage('ts title="a.ts"')` 失败，**不高亮**；
 * - 代码头部的语言标签把整条 info 原样显示出来（用户看到 `ts title="a.ts"`）。
 *
 * 高亮与标签必须**共用同一份归一化结果**：两处各解析一次，迟早漂
 * （一处显示 `tsx`、一处不认 `tsx`）。
 */

/** 围栏信息：语言（用于高亮）+ 可读标签（用于代码头部） */
export interface FenceInfo {
  /** 归一化后的语言（`null` = 没写或无法识别） */
  lang: string | null;
  /** 原始写法（`tsx` / `js:app.js` 里的文件名 / `{1,3}` 高亮行号） */
  raw: string;
  /** 给用户看的标签：优先文件名，其次语言名 */
  label: string | null;
}

/**
 * 语言别名 → hljs 认可的名字。
 *
 * 键必须是**用户会写出来的形式**，值必须是 hljs 能认的（`hljs.getLanguage` 能查到）。
 * 一条规则：**只归一化"用户真的会写"的别名**，不要为了覆盖面把 200 个 hljs
 * 内部别名都抄一遍——抄错的比不抄的更糟。
 */
export const LANG_ALIASES: Record<string, string> = {
  // JS 家族
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  // 脚本
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  // 数据
  yml: 'yaml',
  md: 'markdown',
  // 其它常见
  py: 'python',
  rb: 'ruby',
  golang: 'go',
  'c++': 'cpp',
  'c#': 'csharp',
  cs: 'csharp',
  objc: 'objectivec',
  'obj-c': 'objectivec',
  vue: 'html',
  text: 'plaintext',
  txt: 'plaintext',
};

/** 归一化一个语言标记（小写、去空白）；未登记的原样返回 */
export function normalizeLang(raw: string): string {
  const key = raw.trim().toLowerCase();
  if (!key) return '';
  return LANG_ALIASES[key] ?? key;
}

/** 语言标签的展示名：登记过的别名要回显用户写的形式，而不是归一化后的内部名 */
const DISPLAY_NAMES: Record<string, string> = {
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  bash: 'Bash',
  yaml: 'YAML',
  markdown: 'Markdown',
  python: 'Python',
  ruby: 'Ruby',
  go: 'Go',
  cpp: 'C++',
  csharp: 'C#',
  objectivec: 'Objective-C',
  html: 'HTML',
  css: 'CSS',
  json: 'JSON',
  plaintext: 'Text',
};

/**
 * 拆围栏 info 串：`tsx:app.tsx` / `ts title="a.ts"` / `sh {1,3}` / `ts {highlightLines}`。
 *
 * 返回的 `label` 只取**文件名**（`app.tsx`）或原始语言写法；`{1,3}` 这类高亮行号
 * 不显示在标签上（它是给工具看的，不是给读者看的）。
 */
export function parseFenceInfo(info: string): FenceInfo {
  const raw = (info ?? '').trim();
  if (!raw) return { lang: null, raw: '', label: null };

  // ①行号区间 `{1,3}` / 高亮行（markdown-it-attrs 等插件的记号）：剥掉
  const withoutRanges = raw.replace(/\{[^}]*\}/g, '').trim();
  // ②其余 token 按空白切
  const parts = withoutRanges.split(/\s+/).filter(Boolean);
  const first = parts[0] ?? '';
  // ③`lang:filename`（vim 风格）与 `lang="file"`（attrs 风格）
  const colon = first.indexOf(':');
  const eq = first.indexOf('=');
  const cut = [colon, eq].filter((i) => i > 0).sort((a, b) => a - b)[0];
  const langToken = cut ? first.slice(0, cut) : first;
  const filePart = cut ? first.slice(cut + 1).replace(/^["']|["']$/g, '') : '';

  // `ts title="a.ts"` 这种 attrs 写法：标签取属性值（读者想看的是文件名），
  // 不是 `title="a.ts"` 整串，也不是前面的 `ts`
  const titled = /\btitle=["']([^"']+)["']/.exec(withoutRanges)?.[1] ?? '';

  const lang = normalizeLang(langToken);
  const display = filePart || titled || parts[0] || DISPLAY_NAMES[lang] || langToken;
  return {
    lang: lang || null,
    raw,
    label: display || null,
  };
}
