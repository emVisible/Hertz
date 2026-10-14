/**
 * 排版基线图的样例与渲染入口（v0.36）。
 *
 * 为什么要有这个东西：mdcore 的结构层测试能证"产物结构对不对"，证不了"看起来好不好"。
 * 这一轮的判断很直接——**排版是观感问题，观感只能在产物层判**。而"人工看一眼"
 * 既不可复现也不可回归：改一次字号可能让 24 页卡片的第 7 页溢出，而这在 151 条
 * 结构断言里一条都不会红。
 *
 * 所以每套主题 × 每份样例都要有一张基准图，改动后自动重拍并逐像素比对。
 *
 * 两条纪律：
 * 1. **内容必须像素稳定**：不用远程图片（网络抖动 = 基线永久飘）、不用随机内容、
 *    不用依赖系统动画。图片用内联 SVG data URL。
 * 2. **环境必须记账**：基准图只在同机同 Chromium 下可比，manifest 里记平台、
 *    Chromium 版本与字体探针（固定字符串的测量宽度）。换了机器/字体时读数不可比，
 *    此时应当 `--update` 重录，而不是把阈值放大。
 */
/**
 * 基线页面必须注入 KaTeX 样式表。
 *
 * 排版基线的意义是"验真实产物"。公式这条链路此前从未在基线里出现过，所以它塌了
 * 也没人知道；现在样例里加了公式，就必须让基线跑在**带 CSS** 的页面上——否则验的
 * 只是源码回落形态，等于把缺陷固化进基准图。
 * `?inline` 是 vite 的能力（基线页由 vite build 产出）；tsconfig 的 include 只有
 * src/，所以这里不参与 tsc 检查。
 */
// @ts-expect-error vite 的 ?inline 导入，tsc 不检查 fixtures/
import katexCss from 'katex/dist/katex.min.css?inline';

if (typeof document !== 'undefined' && !document.getElementById('mdcore-katex-css')) {
  const style = document.createElement('style');
  style.id = 'mdcore-katex-css';
  style.textContent = katexCss;
  document.head.appendChild(style);
}

import {
  applyTheme,
  getTheme,
  listThemes,
  parseToIR,
  xhsCards,
  XHS_CARD,
  type Theme,
} from '../src/index';

/** 样例 1：微信/知乎向长文——标题层级、列表、引用、表格、代码、分隔线齐全 */
export const ARTICLE_MD = [
  '# 把设计判断写下来',
  '',
  '[toc]',
  '',
  '这一节讲**为什么**要这样排，而不是讲怎么实现。先说结论，再给理由。',
  '',
  '## 三条取舍',
  '',
  '1. 标题只加一种装饰',
  '2. 序号与正文分色',
  '3. 段距用 em 而不是 px',
  '',
  '> 排版的第一原则是层级可读。装饰越多，层级反而越难读——因为每一种装饰都在喊。',
  '',
  '> [!TIP]',
  '> 正文里的强调优先用 ==荧光笔==，而不是把整句加粗——加粗会让中文笔画糊成团。',
  '',
  '- [x] 已完成：结构一处作者',
  '- [ ] 未完成：主题只写性格 :sparkles:',
  '',
  '重点在[color:#c2410c]层级可读[/color]，不在装饰数量。',
  '',
  '| 层级 | 字号 | 装饰 |',
  '| :--- | :---: | ---: |',
  '| h1 | 1.7em | 一种 |',
  '| h2 | 1.4em | 一种 |',
  '| h3 | 1.18em | 一种 |',
  '',
  '行内公式 $E = mc^2$、行内插图 ![示例配图](${PLACEHOLDER_SVG}){30% left} 与[color:#c2410c]彩色文字[/color]混排。',
  '',
  '$$\\frac{a}{b} = c$$',
  '',
  '```ts',
  'const spacing = "0.62em"; // 改字号时它跟着缩放',
  '```',
  '',
  '### 关于中文正文',
  '',
  '中文字间距用 em 级的小值（0.02em 上下）比 letter-spacing: normal 更稳；两端对齐在'
  + '窄栏里容易拉出"河流"，所以正文默认保持左对齐，行长靠 measure 控。',
  '',
  '---',
  '',
  '## 小结',
  '',
  '- 结构一处作者，主题只写性格',
  '- 装饰必须是真元素',
  '- 节奏用 em',
  '',
  '#排版实践 #中文写作',
  '',
].join('\n');

/** 样例 2：小红书卡片向短文——大字号、序号、荧光与分隔线是主角 */
export const CARD_MD = [
  '# 三件今天就能做的小事',
  '',
  '把排版当产品做，而不是当模板选。',
  '',
  '1. **先定层级**，再挑装饰',
  '2. 段落间距跟着字号走',
  '3. 一次只改一件事，改完立刻看产物',
  '',
  '> 排版没有玄学，只有取舍。',
  '',
  '把[color:#b45309]重心[/color]放在一句话上。',
  '',
  '—— 记下来，明天照着做一遍',
  '',
].join('\n');

/**
 * 样例 3：小红书**长文正文页**——内容长到必然分页（切片 3 的回归网）。
 *
 * 为什么必须有它：卡片基线早先只拍 `pages[0]`，而 `pages[0]` 在封面独立成页之后
 * 变成了**封面**——正文页一次都没被拍到。分页错位、跨页拆坏、强制分页失效，
 * 在这套基线里全都看不见（"导出的图片不对"长期没被发现的直接原因）。
 */
export const CARD_LONG_MD = [
  '# 长文分页回归样例',
  '',
  '第一段正文，用来占掉封面之后的第一张卡。这一段刻意写得比较长，',
  '好让测量台在这一页就接近装满，从而把第二段挤到下一页去。',
  '',
  '## 第一节',
  '',
  '第二节正文。段落之间的断行、字号与行距都会体现在基线图上，',
  '任何一处改动都会让这张图动。',
  '',
  '- 列表项甲',
  '- 列表项乙',
  '',
  '> 引用块跨页时不该被拦腰截断成孤零零一行。',
  '',
  '---',
  '',
  '## 第二节',
  '',
  '第三节正文。上面那条 `---` 应当把这一节整体推到新的一张卡上。',
  '',
  '| 项目 | 值 |',
  '| --- | --- |',
  '| 比例 | 3:4 |',
  '',
  '最后一段，用来验证页尾不会被顶出去。',
  '',
].join('\n');

/** 内联 SVG 占位图：像素稳定，且能看出圆角/边框/图注是否生效 */
// 内联 SVG 占位图：像素稳定，且能看出圆角/边框/图注是否生效。
// **不能含字面空格**：markdown 的链接地址在空格处终止，整行会退化成普通文本
// （第一版夹具就踩了这个坑，靠基线图一眼看出来）。
const PLACEHOLDER_SVG = [
  "data:image/svg+xml;charset=utf-8,",
  "%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='640'%20height='360'%20viewBox='0%200%20640%20360'%3E",
  "%3Crect%20width='640'%20height='360'%20fill='%23e8e4dc'/%3E",
  "%3Ccircle%20cx='320'%20cy='150'%20r='54'%20fill='%23b9b2a4'/%3E",
  "%3Crect%20x='200'%20y='232'%20width='240'%20height='14'%20rx='7'%20fill='%23cdc6b8'/%3E",
  "%3Crect%20x='250'%20y='262'%20width='140'%20height='14'%20rx='7'%20fill='%23d8d2c6'/%3E",
  '%3C/svg%3E',
].join('');

const ARTICLE_WITH_IMAGE = ARTICLE_MD.replace(
  '### 关于中文正文',
  `![示例配图](${PLACEHOLDER_SVG}){70% left}\n\n### 关于中文正文`,
);

/** 画布几何：三个平台的逻辑宽（小红书是 1242 导出坐标系） */
const WIDTHS: Record<Theme['platform'], number> = {
  wechat: 375,
  zhihu: 690,
  xhs: XHS_CARD.width,
  generic: 690,
};

export interface BaselineShot {
  /** 文件名（不含扩展名）：`<platform>-<theme>-<sample>` */
  id: string;
  themeId: string;
  platform: string;
  sample: 'article' | 'card' | 'card-page';
  width: number;
  height: number;
  /** 渲染好的元素（已挂进 body） */
  el: HTMLElement;
}

/**
 * 一张基准图 = 一个主题在一个平台上的一份样例。
 * 小红书走分页卡（取第一页），微信/知乎走整段文流。
 */
export function buildShots(): BaselineShot[] {
  const shots: BaselineShot[] = [];
  for (const { id: themeId, platform } of listThemes()) {
    const theme = getTheme(themeId);
    const width = WIDTHS[platform];

    if (platform === 'xhs') {
      // ①封面页（pages[0]）：角标/标题/副标题的排版
      const cover = xhsCards(parseToIR(CARD_MD), {
        theme,
        footer: '图文工坊',
        qr: null,
        coverSubtitle: '看完能少走半年弯路',
        coverBadge: '建议收藏',
      });
      const coverSlot = document.createElement('div');
      coverSlot.style.width = `${XHS_CARD.width}px`;
      coverSlot.appendChild(cover.pages[0]);
      shots.push({
        id: `${platform}-${themeId}-card`,
        themeId,
        platform,
        sample: 'card',
        width: XHS_CARD.width,
        height: XHS_CARD.height,
        el: coverSlot,
      });
      // ②正文页（长文样例的第一张正文卡）：分页、跨页拆分、强制分页都发生在这里
      const long = xhsCards(parseToIR(CARD_LONG_MD), { theme, footer: '图文工坊', qr: null });
      const contentPage = long.pages[1] ?? long.pages[0];
      const pageSlot = document.createElement('div');
      pageSlot.style.width = `${XHS_CARD.width}px`;
      pageSlot.appendChild(contentPage);
      shots.push({
        id: `${platform}-${themeId}-card-page`,
        themeId,
        platform,
        sample: 'card-page',
        width: XHS_CARD.width,
        height: XHS_CARD.height,
        el: pageSlot,
      });
      continue;
    }

    const el = applyTheme(parseToIR(platform === 'zhihu' ? ARTICLE_MD : ARTICLE_WITH_IMAGE), theme);
    el.style.width = `${width}px`;
    el.style.boxSizing = 'border-box';
    shots.push({
      id: `${platform}-${themeId}-article`,
      themeId,
      platform,
      sample: 'article',
      width,
      height: 0,
      el,
    });
  }
  return shots;
}

/** 字体探针：固定字符串的测量宽度——字体栈变了这个数就会变，基线也就不可比了 */
export function fontProbe(): number {
  const span = document.createElement('span');
  span.textContent = '排版基线字体探针 Typography 0123456789';
  span.style.position = 'absolute';
  span.style.visibility = 'hidden';
  span.style.whiteSpace = 'nowrap';
  span.style.font = "16px ${TOKEN_PROBE_FONT}";
  document.body.appendChild(span);
  const width = span.getBoundingClientRect().width;
  span.remove();
  return Math.round(width * 100) / 100;
}

const TOKEN_PROBE_FONT = "'PingFang SC', 'Songti SC', -apple-system, sans-serif";

/** 页面上下文暴露给 Electron 主进程（capture 侧只做一件事：截图 + 量探针） */
declare global {
  interface Window {
    __typographyShots: () => BaselineShot[];
    __fontProbe: number;
  }
}

if (typeof window !== 'undefined') {
  window.__typographyShots = buildShots;
  window.__fontProbe = fontProbe();
}

export {};
