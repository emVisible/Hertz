/**
 * Shiki 运行时（细粒度打包，v0.37 / P1-3）。
 *
 * 为什么单独一个文件：`shiki` 的顶层入口把 **700 多种语言**一起打进产物，
 * 而我们只需要三十来个。本文与主模块之间只隔一层动态 import（`shiki.ts` 的
 * `defaultHighlighter()`），于是整份 grammar/theme 只在**稿子里真的有代码块**
 * 时才加载；没有代码块的稿子一个字节都不多付。
 *
 * 为什么在这里静态 import 那些 grammar 而不是每个语言各写一次 `import()`：
 * 每个语言单独动态 import 会让打包器切出三十多个 chunk（IIFE 构建里还会全部
 * 内联回主 bundle）。集中在一个模块里 = 一个 chunk，这正是排版基线那种
 * 不可拆分的构建所需要的形状。
 *
 * 为什么用 JavaScript 正则引擎而不是默认的 oniguruma：**WASM**。
 * oniguruma 要额外加载 `onig.wasm` 二进制，而基线页是 `file://` 下的单文件
 * IIFE、Electron 打包版也是本地资源——为一份"离线可用"的排版内核引入一条
 * WASM 装载链路，收益远小于代价。JS 引擎慢一点，但代码块只有几十行，且
 * 结果完全确定（同一份 token 色不会因引擎而漂移，基线才可比）。
 */
import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

// 语言集：**对齐 highlight.js 的 common 子集**。
// 换句话说，Shiki 接进来之后「原来能高亮的语言一个没少」，多出来的只是精度。
import bash from 'shiki/langs/bash.mjs';
import c from 'shiki/langs/c.mjs';
import cpp from 'shiki/langs/cpp.mjs';
import csharp from 'shiki/langs/csharp.mjs';
import css from 'shiki/langs/css.mjs';
import diff from 'shiki/langs/diff.mjs';
import go from 'shiki/langs/go.mjs';
import graphql from 'shiki/langs/graphql.mjs';
import ini from 'shiki/langs/ini.mjs';
import java from 'shiki/langs/java.mjs';
import javascript from 'shiki/langs/javascript.mjs';
import json from 'shiki/langs/json.mjs';
import kotlin from 'shiki/langs/kotlin.mjs';
import less from 'shiki/langs/less.mjs';
import lua from 'shiki/langs/lua.mjs';
import makefile from 'shiki/langs/makefile.mjs';
import markdown from 'shiki/langs/markdown.mjs';
import objectiveC from 'shiki/langs/objective-c.mjs';
import perl from 'shiki/langs/perl.mjs';
import php from 'shiki/langs/php.mjs';
import python from 'shiki/langs/python.mjs';
import r from 'shiki/langs/r.mjs';
import ruby from 'shiki/langs/ruby.mjs';
import rust from 'shiki/langs/rust.mjs';
import scss from 'shiki/langs/scss.mjs';
import sql from 'shiki/langs/sql.mjs';
import swift from 'shiki/langs/swift.mjs';
import typescript from 'shiki/langs/typescript.mjs';
import vb from 'shiki/langs/vb.mjs';
import xml from 'shiki/langs/xml.mjs';
import yaml from 'shiki/langs/yaml.mjs';

// 主题集：7 套预设用到的全部浅深两版（见 shiki.ts 的 CODE_THEME_SHIKI）。
// 全静态导入是为了让「换预设」不需要重新装载引擎——预设是界面上的下拉，
// 用户点一下就该立刻变，不该等一次 chunk 加载。
import githubLight from 'shiki/themes/github-light.mjs';
import githubDark from 'shiki/themes/github-dark.mjs';
import vitesseLight from 'shiki/themes/vitesse-light.mjs';
import vitesseDark from 'shiki/themes/vitesse-dark.mjs';
import catppuccinLatte from 'shiki/themes/catppuccin-latte.mjs';
import catppuccinMocha from 'shiki/themes/catppuccin-mocha.mjs';
import dracula from 'shiki/themes/dracula.mjs';
import nord from 'shiki/themes/nord.mjs';
import oneLight from 'shiki/themes/one-light.mjs';
import oneDarkPro from 'shiki/themes/one-dark-pro.mjs';

const LANGS = [
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  go,
  graphql,
  ini,
  java,
  javascript,
  json,
  kotlin,
  less,
  lua,
  makefile,
  markdown,
  objectiveC,
  perl,
  php,
  python,
  r,
  ruby,
  rust,
  scss,
  sql,
  swift,
  typescript,
  vb,
  xml,
  yaml,
];

const THEMES = [
  githubLight,
  githubDark,
  vitesseLight,
  vitesseDark,
  catppuccinLatte,
  catppuccinMocha,
  dracula,
  nord,
  oneLight,
  oneDarkPro,
];

let pending: Promise<HighlighterCore> | null = null;

/** 进程内单例：构造一次高亮器约 100ms+，每块代码重建一次会明显卡顿 */
export function runtimeHighlighter(): Promise<HighlighterCore> {
  if (!pending) {
    pending = createHighlighterCore({
      themes: THEMES,
      langs: LANGS,
      engine: createJavaScriptRegexEngine(),
    }).catch((e) => {
      pending = null; // 失败不缓存：下次调用允许重试
      throw e;
    });
  }
  return pending;
}