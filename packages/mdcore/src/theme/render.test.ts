import { describe, expect, it } from 'vitest';
import { applyTheme, getTheme, parseToIR } from '../index';
import { cjkNumeral } from './apply';
import type { Theme, ThemeTokens } from './types';

/**
 * 渲染层排版判据（v0.36）。
 *
 * 这层盯的是**产物结构**：标题的 prefix/content 两层 span、自绘序号、代码卡片壳、
 * 表格斑马纹、图注、大引号、三圆点……它们全是**真元素**而不是伪元素——
 * 伪元素过不了微信清洗器（内联走 getComputedStyle，读不出伪元素的 content 与背景）。
 * 结构对了，三个平台的产物才都对；样式值对不对由 derive.test.ts 钉。
 */

function render(md: string, patch: Partial<ThemeTokens> = {}, theme: Theme | string = 'modi'): HTMLElement {
  return applyTheme(parseToIR(md), theme, patch as never);
}

describe('容器基线', () => {
  it('容器挂齐字体/节奏/墨色/画布底，中文断行三条（strict + break-word + 不孤字）', () => {
    const el = render('正文。', { letterSpacing: '0.04em' });
    expect(el.style.fontSize).toBe('16px');
    expect(el.style.lineHeight).toBe('1.8');
    expect(el.style.letterSpacing).toBe('0.04em');
    expect(el.style.color).toBe('rgb(43, 43, 43)'); // ink
    expect(el.style.backgroundColor).toBe('rgb(255, 255, 255)'); // canvasBg
    expect(el.style.lineBreak).toBe('strict');
    expect(el.style.wordBreak).toBe('break-word');
    expect(el.style.overflowWrap).toBe('break-word');
  });

  it('画布底色由 canvasBg token 统管；主题自己声明了 container 底色时以它为准', () => {
    // 结构基座统一把 container 底色接到 canvasBg 上——一处真相源，主题不各写一份
    expect(render('正文。', { canvasBg: '#123456' }, 'modi').style.backgroundColor).toBe('rgb(18, 52, 86)');
    expect(render('正文。', {}, 'wanfeng').style.backgroundColor).toBe('rgb(23, 24, 28)');
    // 自定义主题（设计器产物）显式写了 container 底色时，canvasBg 不压它
    const custom = {
      ...getTheme('modi'),
      styles: { ...getTheme('modi').styles, container: { 'background-color': '#fefefe' } },
    };
    expect(applyTheme(parseToIR('正文。'), custom, { canvasBg: '#123456' }).style.backgroundColor).toBe(
      'rgb(254, 254, 254)',
    );
  });
});

describe('标题：prefix / content 两层真元素', () => {
  it('每级标题都是「编号槽 + 内容槽」，内容槽 inline-block 且渐变可跨行', () => {
    const el = render('## 二级标题\n\n正文。');
    const h2 = el.querySelector('h2') as HTMLElement;
    const prefix = h2.firstElementChild as HTMLElement;
    const content = h2.lastElementChild as HTMLElement;
    expect(prefix.className).toBe('mdcore-h-prefix');
    expect(content.className).toBe('mdcore-h-content');
    expect(prefix.getAttribute('aria-hidden')).toBe('true');
    expect(content.textContent).toBe('二级标题');
    expect(content.style.display).toBe('inline-block');
    expect(content.style.boxDecorationBreak).toBe('clone');
  });

  it('section-number 样式把章节编号物化进编号槽，且只对二级标题计数', () => {
    const el = render(
      '## 甲\n\n正文\n\n### 甲的子节\n\n## 乙\n\n### 乙的子节\n',
      { headingStyle: 'section-number' },
    );
    const h2s = Array.from(el.querySelectorAll('h2')) as HTMLElement[];
    expect(h2s.map((h) => (h.firstElementChild as HTMLElement).textContent)).toEqual(['01', '02']);
    // 三级标题不参与编号（编号是"章"，不是"小节"）
    const h3 = el.querySelector('h3') as HTMLElement;
    expect((h3.firstElementChild as HTMLElement).textContent).toBe('');
  });

  it('pill 样式下标题是 inline-block 药丸，字色 = 主色底上的对比色', () => {
    const el = render('## 标题\n', { headingStyle: 'pill', color: '#ffd166' });
    const h2 = el.querySelector('h2') as HTMLElement;
    expect(h2.style.display).toBe('inline-block');
    expect(h2.style.backgroundColor).toBe('rgb(255, 209, 102)');
    expect(h2.style.color).toBe('rgb(27, 27, 27)'); // 浅主色上必须深字
  });
});

describe('字号阶梯用 em（换字号不换比例）', () => {
  it('标题/正文比值与主题字号无关：30px 小红书卡片与 16px 微信正文是同一套层级', () => {
    const big = render('# 标题\n\n正文。', { fontSize: '30px' }, 'taoyao');
    const small = render('# 标题\n\n正文。', { fontSize: '16px' }, 'modi');
    const h1Of = (el: HTMLElement) => el.querySelector('h1') as HTMLElement;
    // 阶梯用 em：两套主题的标题都是 1.7em，实际像素随正文走（30px 时标题 51px）
    expect(h1Of(big).style.fontSize).toBe('1.7em');
    expect(h1Of(small).style.fontSize).toBe(h1Of(big).style.fontSize);
    expect(big.style.fontSize).toBe('30px');
    expect(small.style.fontSize).toBe('16px');
    // 阶梯写成 px 时这条立刻红：27px/30px 与 27px/16px 是两套层级
    expect(h1Of(small).style.fontSize).not.toBe('27px');
  });
});

describe('段落：em 节奏 + 中文排版三件套', () => {
  it('首行缩进 / 行长上限 / 两端对齐 都由 token 驱动', () => {
    const el = render('正文。', { indent: '2em', measure: '34em', align: 'justify' });
    const p = el.querySelector('p') as HTMLElement;
    expect(p.style.textIndent).toBe('2em');
    expect(p.style.maxWidth).toBe('34em');
    expect(p.style.textAlign).toBe('justify');
    // text-justify 不在 jsdom 的 CSS 属性白名单里（读回来是空），真浏览器里已下发；
    // 这条判据只钉"两端对齐生效"，不断言 jsdom 表达不了的属性
    expect(p.style.textWrap).toBe('pretty');
  });

  it('段距是 em：字号改大时段距跟着缩放（px 间距做不到这件事）', () => {
    const el = render('正文。', { paraSpacing: '1.2em' });
    const p = el.querySelector('p') as HTMLElement;
    expect(p.style.marginBottom).toBe('1.2em');
  });

  it('默认不缩进、不限行长（indent=0 / measure=none 时不写这两条）', () => {
    const p = render('正文。').querySelector('p') as HTMLElement;
    expect(p.style.textIndent).toBe('');
    expect(p.style.maxWidth).toBe('');
  });
});

describe('列表：序号自绘（能跟主色、能用中文数字、能跨页续接）', () => {
  it('无序/有序都关掉浏览器 marker，改画自己的序号 span', () => {
    const el = render('- 甲\n- 乙\n\n1. 一\n2. 二\n');
    const lists = Array.from(el.querySelectorAll('ul, ol')) as HTMLElement[];
    expect(lists.map((l) => l.style.listStyle)).toEqual(['none', 'none']);
    const markers = Array.from(el.querySelectorAll('.mdcore-marker')).map((m) => m.textContent);
    expect(markers).toEqual(['•', '•', '1.', '2.']);
    // 序号与正文是两个 span —— 这样序号才能单独上色
    const li = el.querySelector('li') as HTMLElement;
    expect(li.children[0].className).toBe('mdcore-marker');
    expect(li.children[1].className).toBe('mdcore-li-content');
  });

  it('cjk-numeral 样式：序号是中文数字', () => {
    const el = render('1. 一\n2. 二\n', { listStyle: 'cjk-numeral' });
    const markers = Array.from(el.querySelectorAll('.mdcore-marker')).map((m) => m.textContent);
    expect(markers).toEqual(['一', '二']);
  });

  it('cjkNumeral 覆盖 0-99（含十位与零头）', () => {
    expect([1, 2, 9, 10, 11, 15, 20, 21, 42, 99].map(cjkNumeral)).toEqual([
      '一', '二', '九', '十', '十一', '十五', '二十', '二十一', '四十二', '九十九',
    ]);
    expect(cjkNumeral(100)).toBe('一百');
  });
});

describe('代码卡片：头部语言标签 / Mac 三色点 / 无横滚撑破', () => {
  const MD = '```ts\nconst a = 1;\n```\n';

  it('lang 模式：卡片壳 + 头部语言标签', () => {
    const el = render(MD, { codeBar: 'lang' });
    const card = el.querySelector('.mdcore-code') as HTMLElement;
    expect(card).not.toBeNull();
    expect((card.querySelector('.mdcore-code-lang') as HTMLElement).textContent).toBe('ts');
    expect(card.querySelectorAll('.mdcore-code-dot').length).toBe(0);
  });

  it('mac 模式：三色点是**有尺寸**的真实节点（伪元素过不了微信清洗器）', () => {
    const el = render(MD, { codeBar: 'mac' });
    const dots = Array.from(el.querySelectorAll('.mdcore-code-dot')) as HTMLElement[];
    expect(dots.length).toBe(3);
    expect(dots.map((d) => d.style.backgroundColor)).toEqual([
      'rgb(255, 95, 87)',
      'rgb(254, 188, 46)',
      'rgb(40, 200, 64)',
    ]);
    // 这条断言是补上的：早先只断言背景色，把「空 span 0×0、真浏览器里根本看不见」
    // 这个缺陷钉成了"正确"。颜色对了不等于看得见——尺寸才算。
    for (const dot of dots) {
      expect(dot.style.width).toBeTruthy();
      expect(dot.style.height).toBeTruthy();
    }
  });

  it('none 模式：没有头部（省一条 chrome，但代码体一样在卡片里）', () => {
    const el = render(MD, { codeBar: 'none' });
    expect(el.querySelector('.mdcore-code-head')).toBeNull();
    expect(el.querySelector('.mdcore-code pre')).not.toBeNull();
  });
});

describe('表格：斑马纹逐行写死（产物里没有 <style>，nth-child 不存在）', () => {
  const MD = '| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n| 5 | 6 |\n';

  it('偶数行拿到 zebra 底色，奇数行没有', () => {
    const rows = Array.from(render(MD).querySelectorAll('tbody tr')) as HTMLElement[];
    expect(rows).toHaveLength(3);
    expect(rows[0].style.backgroundColor).toBe('');
    expect(rows[1].className).toBe('mdcore-row-even');
    expect(rows[1].style.backgroundColor).not.toBe('');
    expect(rows[2].style.backgroundColor).toBe('');
  });
});

describe('图片：有 alt 才有图注，整块是 figure', () => {
  it('带 alt → figure > img + figcaption', () => {
    const el = render('![夜色里的城市](https://example.com/a.png)');
    const figure = el.querySelector('figure') as HTMLElement;
    expect(figure).not.toBeNull();
    expect((figure.querySelector('figcaption') as HTMLElement).textContent).toBe('夜色里的城市');
    expect(figure.querySelector('img')?.getAttribute('src')).toBe('https://example.com/a.png');
  });

  it('空 alt → 不生成 figcaption（空图注占一行是排版事故）', () => {
    const el = render('![](https://example.com/a.png)');
    expect(el.querySelector('figcaption')).toBeNull();
    expect(el.querySelector('figure')).not.toBeNull();
  });
});

describe('引用：大引号是物化节点，嵌套层级有视觉差', () => {
  it('quote-mark 样式物化一个 “ （伪元素读不出来）', () => {
    const el = render('> 引用一句\n', { quoteStyle: 'quote-mark' });
    const quote = el.querySelector('blockquote') as HTMLElement;
    const mark = quote.firstElementChild as HTMLElement;
    expect(mark.className).toBe('mdcore-quote-mark');
    expect(mark.textContent).toBe('“');
    expect(mark.getAttribute('aria-hidden')).toBe('true');
  });

  it('非 quote-mark 样式不生成引号节点', () => {
    const el = render('> 引用一句\n', { quoteStyle: 'left-bar' });
    expect(el.querySelector('.mdcore-quote-mark')).toBeNull();
  });

  it('嵌套引用拿到第二层样式', () => {
    const el = render('> 外层\n>\n> > 内层\n');
    const inner = el.querySelector('.mdcore-quote-l2');
    expect(inner).not.toBeNull();
  });
});

describe('分隔线：三圆点是三个真实节点', () => {
  it('dots 样式渲染 3 个 dot span，其余样式走 <hr>', () => {
    const dots = render('a\n\n---\n\nb', { hrStyle: 'dots' }).querySelector('.mdcore-hr-dots');
    expect(dots).not.toBeNull();
    expect(dots!.querySelectorAll('.mdcore-hr-dot').length).toBe(3);
    expect(render('a\n\n---\n\nb', { hrStyle: 'short' }).querySelector('hr')).not.toBeNull();
  });
});