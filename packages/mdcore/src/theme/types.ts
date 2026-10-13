/**
 * 主题系统（§4）：主题 = TS 对象 { id, name, platform, tokens, styles }。
 * 内置 8 套预留：微信 3 / 小红书 3 / 知乎 2；切片 A 先落微信向 2 套（墨滴/晚风），
 * platform 字段与 styles 形状即后续 6 套的扩展位。
 */

/** CSS 属性表：kebab-case 属性 → 字面值（允许 `${token}` 引用 tokens） */
export type StyleProps = Record<string, string>;

export interface ThemeTokens {
  /** 主色（色盘换色/微调 overrides 的核心） */
  color: string;
  fontFamily: string;
  fontSize: string;
  lineHeight: string;
  radius: string;
}

/** 微调 overrides：随排版稿入库 = 「我的主题」（§4） */
export type ThemeOverrides = Partial<ThemeTokens>;

export type ThemePlatform = 'wechat' | 'xhs' | 'zhihu' | 'generic';

/**
 * styles 键位（元素 → CSS）：
 * container / h1..h6 / para / link / strong / em / inlineCode /
 * list / listItem / pre / code / table / th / td / quote / image /
 * callout / callout-<variant> / formula / hr / hljs-*（代码高亮 token 色）
 */
export interface Theme {
  id: string;
  name: string;
  /** 平台调优（微信/小红书/知乎/generic） */
  platform: ThemePlatform;
  tokens: ThemeTokens;
  styles: Record<string, StyleProps>;
}
