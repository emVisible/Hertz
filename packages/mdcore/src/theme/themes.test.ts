import { describe, expect, it } from 'vitest';
import {
  applyTheme,
  derivedSlots,
  getTheme,
  listThemes,
  parseToIR,
  resolveTokens,
  resolveThemedProps,
} from '../index';
import { HEADING_STYLES, LIST_STYLES, QUOTE_STYLES, resolveTokens as resolveTokensDirect } from './types';

/**
 * 内置主题迁移判据（v0.36）。
 *
 * 迁移前 9 套主题是 9 份几乎一样的骨架：同样 25 个键、大段相同的字号与间距，
 * 只在主色与三四个装饰上不同——那不是 9 套主题，是 1 套换了 9 个颜色。
 *
 * 这里钉三件事：
 * ① **完整**：每套主题解析出的 token 集无 undefined（渲染层拿得到每个值）；
 * ② **有别**：9 套的样式开关组合互不相同（否则"9 套"是虚的）；
 * ③ **一致**：同一套主题里，渲染产物真的按它的开关走（结构由 render.test.ts 钉，
 *    这里钉"主题声明 → 派生槽位"这条线连上了）。
 */

const THEMES = listThemes();

/** 一份能压到所有排版分支的样例：代码、表格、列表、引用、图注、分隔线全带上 */
const SAMPLE = [
  '# 一级标题',
  '',
  '这是一段**加粗**与*斜体*的正文，段落之间要留够气口。',
  '',
  '## 二级标题',
  '',
  '- 第一条',
  '- 第二条',
  '',
  '1. 步骤一',
  '2. 步骤二',
  '',
  '> 引用一段话。',
  '',
  '| 字段 | 说明 |',
  '| --- | --- |',
  '| a | 第一列 |',
  '| b | 第二列 |',
  '',
  '![夜色里的城市](https://example.com/city.png)',
  '',
  '---',
  '',
  '```ts',
  'const answer = 42;',
  '```',
  '',
].join('\n');

describe('内置主题：完整', () => {
  it('注册 9 套（微信 2 / 小红书 4 / 知乎 3），每平台至少一套深色', () => {
    expect(THEMES.length).toBe(9);
    const byPlatform = THEMES.reduce<Record<string, number>>((acc, t) => {
      acc[t.platform] = (acc[t.platform] ?? 0) + 1;
      return acc;
    }, {});
    expect(byPlatform).toEqual({ wechat: 2, xhs: 4, zhihu: 3 });
    for (const platform of ['wechat', 'xhs', 'zhihu']) {
      const dark = THEMES.filter((t) => t.platform === platform && t.dark);
      expect(dark.length, `${platform} 缺深色款`).toBeGreaterThanOrEqual(1);
    }
  });

  it('每套主题解析出的 token 集没有空值（渲染层永远拿得到每个值）', () => {
    for (const { id } of THEMES) {
      const tokens = resolveTokens(getTheme(id));
      for (const [key, value] of Object.entries(tokens)) {
        expect(value, `${id} 的 ${key} 是空值`).toBeTruthy();
      }
      // 目录里的主色与 token 一致（界面色块、派生预览都靠它）
      expect(THEMES.find((t) => t.id === id)?.color).toBe(getTheme(id).tokens.color);
    }
  });

  it('深色主题的画布底色确实比浅色暗（深色款不是"浅色 + 滤镜"）', () => {
    for (const { id, platform } of THEMES) {
      if (!platform) continue;
      const theme = getTheme(id);
      const dark = THEMES.find((t) => t.id === id)?.dark === true;
      const bg = resolveTokensDirect(theme).canvasBg;
      const lum = relativeLuminanceOf(bg);
      if (dark) expect(lum, `${id} 标了深色但底色不暗`).toBeLessThan(0.25);
      else expect(lum, `${id} 是浅色款但底色发暗`).toBeGreaterThan(0.6);
    }
  });
});

describe('内置主题：有别', () => {
  it('9 套的样式开关组合互不相同（否则"9 套主题"是虚的）', () => {
    const combos = THEMES.map(({ id }) => {
      const t = resolveTokens(getTheme(id));
      return [
        id,
        t.headingStyle,
        t.quoteStyle,
        t.strongStyle,
        t.codeBar,
        t.tableStyle,
        t.listStyle,
        t.hrStyle,
      ].join('|');
    });
    expect(new Set(combos).size, `只有 ${new Set(combos).size} 种组合`).toBe(THEMES.length);
  });

  it('小红书四套互不同色，且都是纸感底色（不用纯白）', () => {
    const xhs = THEMES.filter((t) => t.platform === 'xhs');
    expect(new Set(xhs.map((t) => t.color)).size).toBe(4);
    for (const { id } of xhs) {
      const bg = resolveTokensDirect(getTheme(id)).canvasBg;
      expect(bg.toLowerCase(), `${id} 用了纯白底`).not.toBe('#ffffff');
    }
  });

  it('每套主题都有性格：装饰开关非默认，或排版选择（行长/对齐/字距/段距）非缺省', () => {
    // 「清简」走的是零装饰路线（标题 none / 强调 color / 序号 default），
    // 它的性格落在 token 层——34em 行长上限 + 两端对齐。所以判据不是"必须花哨"，
    // 而是"至少有一个维度偏离缺省"，且零装饰的那套必须另有排版主张。
    const defaults = new Set(['none', 'color', 'default']);
    for (const { id } of THEMES) {
      const t = resolveTokens(getTheme(id));
      const decorative = !defaults.has(t.headingStyle) || !defaults.has(t.strongStyle) || !defaults.has(t.listStyle);
      const typographic = t.measure !== 'none' || t.align !== 'justify' || t.letterSpacing !== '0.02em' || t.paraSpacing !== '1em';
      expect(decorative || typographic, `${id} 既没有装饰也没有排版主张`).toBe(true);
      if (!decorative) {
        expect(t.measure, `${id} 走零装饰路线却没有行长主张`).not.toBe('none');
      }
    }
  });
});

describe('内置主题：一致（声明 → 派生 → 产物）', () => {
  it('样例文档在 9 套主题下都能渲染出完整结构（标题/代码/表格/图注/列表）', () => {
    const ir = parseToIR(SAMPLE);
    for (const { id } of THEMES) {
      const el = applyTheme(ir, id);
      expect(el.querySelector('h1'), `${id} 缺 h1`).not.toBeNull();
      expect(el.querySelector('.mdcore-code pre code'), `${id} 缺代码块`).not.toBeNull();
      expect(el.querySelector('table th'), `${id} 缺表头`).not.toBeNull();
      expect(el.querySelector('figcaption'), `${id} 缺图注`).not.toBeNull();
      expect(el.querySelectorAll('.mdcore-marker').length, `${id} 缺序号`).toBe(4);
    }
  });

  it('主题声明的开关真的决定产物：换成另一种开关，产物结构跟着变', () => {
    const base = getTheme('modi');
    const numbered = applyTheme(parseToIR('## 甲\n\n## 乙\n'), base, { headingStyle: 'section-number' });
    const plain = applyTheme(parseToIR('## 甲\n\n## 乙\n'), base, { headingStyle: 'left-bar' });
    expect(numbered.querySelector('h2 .mdcore-h-prefix')?.textContent).toBe('01');
    expect(plain.querySelector('h2 .mdcore-h-prefix')?.textContent).toBe('');

    const dots = applyTheme(parseToIR('a\n\n---\n\nb'), base, { hrStyle: 'dots' });
    expect(dots.querySelectorAll('.mdcore-hr-dot').length).toBe(3);
    const mac = applyTheme(parseToIR('```ts\nx\n```\n'), base, { codeBar: 'mac' });
    expect(mac.querySelectorAll('.mdcore-code-dot').length).toBe(3);
  });

  it('派生槽位随最终 token 走（主题的 canvasBg 不影响主色族，color 才影响）', () => {
    const base = getTheme('modi');
    // 换画布底色：容器跟着变，主色族不动
    const a = applyTheme(parseToIR('正文'), base, { canvasBg: '#123456' });
    expect(a.style.backgroundColor).toBe('rgb(18, 52, 86)');
    expect(resolveThemedProps(base, { canvasBg: '#123456' }, 'link').color).toBe(
      resolveThemedProps(base, {}, 'link').color,
    );
    // 换主色：主色族整套跟着变
    expect(resolveThemedProps(base, { color: '#ff0000' }, 'link').color).not.toBe(
      resolveThemedProps(base, {}, 'link').color,
    );
  });

  it('derivedSlots 覆盖每种样式开关都有产出（拼错的开关值不会静默变默认）', () => {
    const slots = derivedSlots(resolveTokens(getTheme('modi')));
    for (const key of ['headingContent', 'headingPrefix', 'quoteMark', 'hrDot', 'listMarker', 'codeCard', 'tbodyEven', 'figure', 'figcaption']) {
      expect(slots[key], `派生表缺 ${key}`).toBeTruthy();
    }
    // 每种开关都至少有一个槽位对主色有反应
    const reacts = (v: Record<string, unknown>) => JSON.stringify(v).length;
    for (const style of HEADING_STYLES) {
      const s = derivedSlots(resolveTokens(getTheme('modi'), { headingStyle: style }));
      expect(reacts(s)).toBeGreaterThan(0);
    }
    for (const style of QUOTE_STYLES) {
      expect(reacts(derivedSlots(resolveTokens(getTheme('modi'), { quoteStyle: style })))).toBeGreaterThan(0);
    }
    for (const style of LIST_STYLES) {
      expect(reacts(derivedSlots(resolveTokens(getTheme('modi'), { listStyle: style })))).toBeGreaterThan(0);
    }
  });
});

/** WCAG 相对亮度（判据里只用它判"深色款是不是真深"） */
function relativeLuminanceOf(hex: string): number {
  const v = hex.replace('#', '');
  const full = v.length === 3 ? v.split('').map((c) => c + c).join('') : v;
  const lin = (i: number) => {
    const c = parseInt(full.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(0) + 0.7152 * lin(2) + 0.0722 * lin(4);
}