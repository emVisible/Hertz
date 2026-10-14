import type { Theme, ThemePlatform, ThemeTokens } from './types';
import { modi } from './themes/modi';
import { wanfeng } from './themes/wanfeng';
import { taoyao } from './themes/taoyao';
import { qingning } from './themes/qingning';
import { mucheng } from './themes/mucheng';
import { xueshu } from './themes/xueshu';
import { qingjian } from './themes/qingjian';
import { yehang } from './themes/yehang';
import { moan } from './themes/moan';

/**
 * 内置主题注册表。设计 §4 共 8 套（微信 3 / 小红书 3 / 知乎 2）；
 * 切片 A 落微信向 2 套，切片 B 落小红书向 3 套（桃夭/青柠/暮橙），
 * 切片 C 落知乎向 2 套（学术/清简）。
 */
const THEMES: Theme[] = [modi, wanfeng, taoyao, qingning, mucheng, xueshu, qingjian, yehang, moan];

/** 用户自建主题的 id 前缀。 */
export const CUSTOM_THEME_PREFIX = 'user:';

/**
 * 主题目录（给界面用）：id/name/platform/dark + 主色。
 *
 * 主色入列是有用的：`InspectorPanel` 的色块本来要 `getTheme(id)` 逐个 try/catch
 * 才拿得到主色，界面渲染 9 次就有 9 次抛错的可能；目录里直接带上就没这些。
 */
export interface ThemeSummary {
  id: string;
  name: string;
  platform: ThemePlatform;
  dark?: boolean;
  /** 主色（色块、色盘派生预览、accentInk 自检都用它） */
  color: string;
}

export function listThemes(): ThemeSummary[] {
  return THEMES.map(({ id, name, platform, dark, tokens }) => ({
    id,
    name,
    platform,
    dark,
    color: tokens.color,
  }));
}

export function getTheme(id: string): Theme {
  const theme = THEMES.find((t) => t.id === id);
  if (!theme) {
    throw new Error(`@hertz/mdcore: unknown theme id "${id}" (available: ${THEMES.map((t) => t.id).join(', ')})`);
  }
  return theme;
}

/**
 * 登记一套自建主题（主题设计器的「保存为我的主题」落到这里）。
 *
 * 两条护栏，都是防"用户数据把内置件顶掉"：
 * 1. id 必须带 `user:` 前缀，且不能与任何内置 id 撞名——否则用户导入一个叫
 *    `modi` 的 JSON 就能改掉「墨滴」本身，升级 mdcore 也删不掉它。
 * 2. 五个必填 token 缺一即拒。`ThemeTokens` 里它们是必填，但 JSON 是运行时进来的，
 *    TS 拦不住（`as ThemeTokens` 是断言不是校验）；少一个 fontSize 就该在这里响亮失败。
 *
 * 同名同 id 视为**更新**（设计器里改完存回去是常规操作，不是错误）。
 */
export function registerTheme(theme: Theme): Theme {
  if (!theme.id.startsWith(CUSTOM_THEME_PREFIX)) {
    throw new Error(`@hertz/mdcore: 自建主题 id 必须以 "${CUSTOM_THEME_PREFIX}" 开头（收到 "${theme.id}"）`);
  }
  const builtin = BUILTIN_IDS.has(theme.id.replace(CUSTOM_THEME_PREFIX, ''));
  if (builtin) {
    throw new Error(`@hertz/mdcore: 自建主题不能占用内置主题名 "${theme.id}"`);
  }
  const REQUIRED: Array<keyof ThemeTokens> = ['color', 'fontFamily', 'fontSize', 'lineHeight', 'radius'];
  const missing = REQUIRED.filter((key) => !theme.tokens?.[key]);
  if (missing.length) {
    throw new Error(`@hertz/mdcore: 自建主题缺少必填 token：${missing.join(', ')}`);
  }
  const at = THEMES.findIndex((t) => t.id === theme.id);
  if (at >= 0) THEMES[at] = theme;
  else THEMES.push(theme);
  return theme;
}

/** 注销自建主题（内置主题删不掉） */
export function unregisterTheme(id: string): boolean {
  if (!id.startsWith(CUSTOM_THEME_PREFIX)) return false;
  const at = THEMES.findIndex((t) => t.id === id);
  if (at < 0) return false;
  THEMES.splice(at, 1);
  return true;
}

export function listCustomThemes(): ThemeSummary[] {
  return listThemes().filter((t) => t.id.startsWith(CUSTOM_THEME_PREFIX));
}

export function isBuiltinTheme(id: string): boolean {
  return BUILTIN_IDS.has(id);
}

/** 清掉全部自建主题（宿主换账号 / 测试隔离用） */
export function clearCustomThemes(): void {
  for (let i = THEMES.length - 1; i >= 0; i -= 1) {
    if (THEMES[i].id.startsWith(CUSTOM_THEME_PREFIX)) THEMES.splice(i, 1);
  }
}

/** id 或主题对象归一化为主题对象 */
export function resolveTheme(theme: Theme | string): Theme {
  return typeof theme === 'string' ? getTheme(theme) : theme;
}

/** 某平台的第一套内置主题（平台适配器的默认值） */
export function defaultThemeFor(platform: ThemePlatform): Theme {
  const theme = THEMES.find((t) => t.platform === platform);
  if (!theme) throw new Error(`@hertz/mdcore: no builtin theme for platform "${platform}"`);
  return theme;
}

const BUILTIN_IDS = new Set<string>([modi, wanfeng, taoyao, qingning, mucheng, xueshu, qingjian, yehang, moan].map((t) => t.id));

export { modi, wanfeng, taoyao, qingning, mucheng, xueshu, qingjian, yehang, moan };

/** 某平台的深色款（预览深色开关用）；没有则 undefined（宿主退回滤镜近似） */
export function darkThemeFor(platform: ThemePlatform): Theme | undefined {
  return THEMES.find((t) => t.platform === platform && t.dark === true);
}
