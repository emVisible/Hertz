import { afterEach, describe, expect, it } from 'vitest';

import {
  clearCustomThemes,
  CUSTOM_THEME_PREFIX,
  getTheme,
  isBuiltinTheme,
  listCustomThemes,
  listThemes,
  registerTheme,
  unregisterTheme,
  type Theme,
} from '../index';

const base = () => getTheme('modi');

function custom(id: string, patch: Partial<Theme['tokens']> = {}): Theme {
  const src = base();
  return {
    ...src,
    id,
    name: id,
    tokens: { ...src.tokens, ...patch },
  };
}

afterEach(() => clearCustomThemes());

describe('自建主题注册表（主题设计器的落点）', () => {
  it('登记后能按 id 取回，并出现在目录里', () => {
    registerTheme(custom(`${CUSTOM_THEME_PREFIX}my-ink`));
    expect(getTheme(`${CUSTOM_THEME_PREFIX}my-ink`).name).toBe(`${CUSTOM_THEME_PREFIX}my-ink`);
    expect(listThemes().some((t) => t.id === `${CUSTOM_THEME_PREFIX}my-ink`)).toBe(true);
    expect(listCustomThemes()).toHaveLength(1);
  });

  it('同名再登记是更新而不是堆第二份', () => {
    const id = `${CUSTOM_THEME_PREFIX}my-ink`;
    registerTheme(custom(id));
    registerTheme({ ...custom(id), name: '改过名的墨' });
    expect(listCustomThemes()).toHaveLength(1);
    expect(getTheme(id).name).toBe('改过名的墨');
  });

  it('注销只认自建主题，内置主题删不掉', () => {
    registerTheme(custom(`${CUSTOM_THEME_PREFIX}gone`));
    expect(unregisterTheme(`${CUSTOM_THEME_PREFIX}gone`)).toBe(true);
    expect(unregisterTheme(`${CUSTOM_THEME_PREFIX}gone`)).toBe(false);
    expect(unregisterTheme('modi')).toBe(false);
    expect(listThemes().some((t) => t.id === 'modi')).toBe(true);
  });

  it('id 不带 user: 前缀即拒——用户数据不许改内置件', () => {
    expect(() => registerTheme(custom('modi'))).toThrow(/user:/);
    expect(() => registerTheme(custom('my-ink'))).toThrow(/user:/);
    // 内置件确实还在
    expect(getTheme('modi')).toBeTruthy();
  });

  it('顶掉内置主题名也拒（去掉前缀撞名同样不行）', () => {
    expect(() => registerTheme(custom(`${CUSTOM_THEME_PREFIX}modi`))).toThrow(/内置主题名/);
    expect(() => getTheme(`${CUSTOM_THEME_PREFIX}modi`)).toThrow();
  });

  it('五个必填 token 缺一即拒（运行时进来的 JSON 拦不住 TS）', () => {
    // 造一个缺 fontSize 的（模拟导入的脏 JSON）：TS 拦不住运行时进来的数据，
    // 所以这里直接按 Record 删，不加 @ts-expect-error（tokens 声明成可选键时它会变成"未使用指令"）
    const broken = custom(`${CUSTOM_THEME_PREFIX}broken`);
    delete (broken.tokens as Record<string, unknown>).fontSize;
    expect(() => registerTheme(broken)).toThrow(/fontSize/);
    expect(listCustomThemes()).toHaveLength(0);
  });

  it('isBuiltinTheme 只认内置清单', () => {
    expect(isBuiltinTheme('modi')).toBe(true);
    expect(isBuiltinTheme(`${CUSTOM_THEME_PREFIX}x`)).toBe(false);
  });

  it('clearCustomThemes 清干净且不动内置件', () => {
    registerTheme(custom(`${CUSTOM_THEME_PREFIX}a`));
    registerTheme(custom(`${CUSTOM_THEME_PREFIX}b`));
    const before = listThemes().length;
    clearCustomThemes();
    expect(listCustomThemes()).toHaveLength(0);
    expect(listThemes().length).toBe(before - 2);
    expect(isBuiltinTheme('xueshu')).toBe(true);
  });
});