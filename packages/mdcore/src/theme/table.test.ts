/**
 * 表格链路的判据（W1 切片 2）。
 *
 * 这一片修的是四件"写了支持、产物里不成立"的事：
 * ① `|:---:|` 的对齐被整个丢弃（convertTable 只取 inline，style 属性没了），
 *    而样式槽又硬写 `text-align:left`——数值列恒左对齐；
 * ② 窄表没有横滚容器：单元格被压扁、逐字折行；
 * ③ 圆角写在 `display:table` 上无效（不产生 BFC），"圆角表头"看不见；
 * ④ 长 URL/长 ID 没有断词策略，会把整张表撑成筛子。
 */
import { describe, expect, it } from 'vitest';

import { applyTheme, parseToIR, paginate, type Measurer } from '../index';

const ALIGNED = ['| 左 | 中 | 右 |', '| :--- | :---: | ---: |', '| a | b | c |', '| d | e | f |'].join('\n');

/** 合成测量器：按 tbody 行数算高 */
const byRows: Measurer = {
  fits(body) {
    return body.querySelectorAll('tbody tr').length <= 3;
  },
};

describe('表格对齐（此前完全丢失）', () => {
  it('`:---` / `:---:` / `---:` 三种写法都进 IR', () => {
    const table = parseToIR(ALIGNED)[0];
    expect(table.type).toBe('table');
    if (table.type !== 'table') return;
    // 按列：markdown 的对齐只由表头下的分隔行决定
    expect(table.align).toEqual(['left', 'center', 'right']);
  });

  it('产物里每格的 text-align 真的落到位', () => {
    const el = applyTheme(parseToIR(ALIGNED), 'modi');
    const ths = Array.from(el.querySelectorAll('thead th')) as HTMLElement[];
    expect(ths.map((th) => th.style.textAlign)).toEqual(['left', 'center', 'right']);
  });

  it('对齐作用于该列的所有单元格（表头与数据行一致）', () => {
    const md = ['| 左 | 右 |', '| :--- | ---: |', '| a | 1 |', '| b | 2 |'].join('\n');
    const el = applyTheme(parseToIR(md), 'modi');
    const tds = Array.from(el.querySelectorAll('tbody td')) as HTMLElement[];
    expect(tds.map((td) => td.style.textAlign)).toEqual(['left', 'right', 'left', 'right']);
  });

  it('整张表没写对齐时 IR 里不留 align 键（下游不该拿到空数组冒充"对齐为空"）', () => {
    const table = parseToIR('| a | b |\n| --- | --- |\n| 1 | 2 |')[0];
    expect(table.type === 'table' ? table.align : 'n/a').toBeUndefined();
    // 产物里的 text-align 来自样式槽（主题默认值），不是 IR 覆盖
    const th = applyTheme(parseToIR('| a | b |\n| --- | --- |\n| 1 | 2 |'), 'modi').querySelector(
      'thead th',
    ) as HTMLElement;
    expect(th.style.textAlign).toBe('left');
  });
});

describe('窄表横滚容器', () => {
  it('块元素是横滚容器，table 在里面', () => {
    const el = applyTheme(parseToIR('| a | b |\n| --- | --- |\n| 1 | 2 |'), 'modi');
    const wrap = el.querySelector('.mdcore-table-wrap') as HTMLElement;
    expect(wrap).toBeTruthy();
    expect(wrap.style.overflowX).toBe('auto');
    expect(wrap.querySelector('table')).toBeTruthy();
  });

  it('块定位标记挂在容器上（画布点选与分页边界靠它）', () => {
    const el = applyTheme(parseToIR('| a | b |\n| --- | --- |\n| 1 | 2 |'), 'modi');
    const wrap = el.querySelector('[data-mdcore-block]') as HTMLElement;
    expect(wrap.className).toContain('mdcore-table-wrap');
  });

  it('单元格可断词（长 URL / 长 ID 不撑破表）', () => {
    const el = applyTheme(parseToIR('| a |\n| --- |\n| x |'), 'modi');
    const td = el.querySelector('tbody td') as HTMLElement;
    expect(td.style.wordBreak).toBe('break-word');
    expect(td.style.overflowWrap).toBe('anywhere');
  });
});

describe('跨页与圆角', () => {
  it('跨页时续页重复表头，且续页也带横滚容器', () => {
    const rows = Array.from({ length: 10 }, (_, i) => `| c${i} |`).join('\n');
    const pages = paginate(parseToIR(`| 名 |\n| --- |\n${rows}`), {
      theme: 'modi',
      page: { width: 320, height: 200, padding: 20 },
      measurer: byRows,
    });
    expect(pages.length).toBeGreaterThan(1);
    const second = pages[1].querySelector('.mdcore-table-wrap') as HTMLElement;
    expect(second).toBeTruthy();
    expect(second.querySelector('thead th')?.textContent).toBe('名');
  });

  it('表头首末格各带圆角（产物里没有 <style>，nth-child 那条规则不存在）', () => {
    const el = applyTheme(parseToIR('| a | b | c |\n| --- | --- | --- |\n| 1 | 2 | 3 |'), 'modi');
    const ths = Array.from(el.querySelectorAll('thead th')) as HTMLElement[];
    expect(ths[0].style.borderTopLeftRadius).toBeTruthy();
    expect(ths[2].style.borderTopRightRadius).toBeTruthy();
    // 中间格不写圆角（否则每格都是圆的，表头看着像药丸排排坐）
    expect(ths[1].style.borderTopLeftRadius).toBe('');
  });
});
