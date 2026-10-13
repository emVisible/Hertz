import type { Theme, ThemePlatform } from './types';
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

export function listThemes(): Array<Pick<Theme, 'id' | 'name' | 'platform' | 'dark'>> {
  return THEMES.map(({ id, name, platform, dark }) => ({ id, name, platform, dark }));
}

export function getTheme(id: string): Theme {
  const theme = THEMES.find((t) => t.id === id);
  if (!theme) {
    throw new Error(`@hertz/mdcore: unknown theme id "${id}" (available: ${THEMES.map((t) => t.id).join(', ')})`);
  }
  return theme;
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

export { modi, wanfeng, taoyao, qingning, mucheng, xueshu, qingjian, yehang, moan };

/** 某平台的深色款（预览深色开关用）；没有则 undefined（宿主退回滤镜近似） */
export function darkThemeFor(platform: ThemePlatform): Theme | undefined {
  return THEMES.find((t) => t.platform === platform && t.dark === true);
}
