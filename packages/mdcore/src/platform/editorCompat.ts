/**
 * 富文本编辑器（微信 / 知乎）的清洗器对抗：分隔线与标题。
 *
 * 这两条是**用户实测反馈**带进来的（2026-10-17）：粘进公众号后 `---`
 * "右居中、左侧一大片空白"，标题被"硬性分为多行"。
 *
 * 共性：两家编辑器都**不是浏览器**。它们按块级排版处理 `display`，
 * 而我们的渲染态大量依赖浏览器的行内/块内语义，于是同一份 DOM 在
 * 画布上是对的、在编辑器里是错的。结构断言对此完全无感——只能打在
 * **产物 HTML** 上（见 `platform/wechat.test.ts` 与 `platform/zhihu.test.ts`）。
 */

/**
 * 分隔线 → 居中短横（`text-align:center` + 内层 inline-block）。
 *
 * ## 为什么不能直接粘 `<hr>`
 *
 * ①**居中不能靠 auto 外边距**。原实现是 `width:48px + margin:2em auto`，
 *   微信编辑器**不吃 auto**，短横于是贴到右边、左边空一大块——正是
 *   用户说的"右居中且左侧空白过长，实质上浏览是空白"。
 *   改用 `text-align:center`：它是编辑器自己菜单里就有的排版项，
 *   与 auto 外边距无关，也不赌它算得出 48px 像素。
 * ②`<hr>` 是浏览器控件，编辑器会套自己的默认样式，粗细与颜色不受控。
 *
 * 线型分三支保形：实心块 / 虚线（dotted）/ 药丸（圆角 + 半高）。
 * 容器刻意不设 `display:flex`——flex 在这两家编辑器里支持不稳。
 */
export function hruleToCenteredSection(root: HTMLElement): void {
  const doc = root.ownerDocument;
  for (const hr of Array.from(root.querySelectorAll('hr'))) {
    const style = hr.style;
    const color = style.getPropertyValue('background-color');
    const marginTop = style.getPropertyValue('margin-top') || '1.6em';
    const marginBottom = style.getPropertyValue('margin-bottom') || '1.6em';
    const width = style.getPropertyValue('width') || '48px';
    const dashed = /dashed/i.test(style.getPropertyValue('border-top-style'));
    const pill = style.getPropertyValue('border-radius').startsWith('999');

    const section = doc.createElement('section');
    section.setAttribute(
      'style',
      `margin:${marginTop} 0 ${marginBottom} 0;text-align:center;line-height:0`,
    );
    const bar = doc.createElement('span');
    const shape = pill
      ? `width:${width};border-top:4px solid ${color};border-radius:999px`
      : dashed
        ? `width:${width};border-top:1px dashed ${color};height:0`
        : `width:${width};height:2px;background-color:${color}`;
    bar.setAttribute('style', `${shape};display:inline-block`);
    section.appendChild(bar);
    hr.replaceWith(section);
  }

  /**
   * 三圆点分隔线（`hrStyle: dots`）的居中同样不能靠 flex——
   * `justify-content:center` 一旦不生效，三个点就贴到左边，
   * 与上面 `<hr>` 同源。改成 text-align 居中 + 点改 inline-block。
   */
  for (const dots of Array.from(root.querySelectorAll('.mdcore-hr-dots')).filter(
    (el): el is HTMLElement => el instanceof HTMLElement,
  )) {
    dots.style.display = 'block';
    dots.style.justifyContent = 'auto';
    dots.style.textAlign = 'center';
    for (const dot of Array.from(dots.children)) {
      (dot as HTMLElement).style.display = 'inline-block';
    }
  }
}

/**
 * 标题里的 inline-block 拍平 —— 编辑器把每个 inline-block 当块，各占一行。
 *
 * 我们的标题是 `<h1><span prefix/><span content>文字</span></h1>`：
 * prefix 是渲染期物化的装饰（章节编号，css counter 不可移植），
 * content 恒为 inline-block（为了药丸/下划线贴着文字走、不撑满版心，
 * 见 `theme/derive.ts`）。浏览器里两者同行，**编辑器里各占一行**——
 * 就是用户说的"标题被硬性分为多行"。
 *
 * 例外：**自身**就是 inline-block 的标题（pill 药丸）保持不动——
 * 那种靠自身底色成立，拍平会把药丸摊成一整行的底。
 */
export function flattenHeadingInlineBlocks(root: HTMLElement): void {
  for (const heading of Array.from(
    root.querySelectorAll('h1, h2, h3, h4, h5, h6'),
  ).filter((el): el is HTMLElement => el instanceof HTMLElement)) {
    if (heading.style.display === 'inline-block') continue;
    for (const span of Array.from(heading.querySelectorAll('span')).filter(
      (el): el is HTMLElement => el instanceof HTMLElement,
    )) {
      if (span.style.display === 'inline-block') span.style.display = 'inline';
    }
  }
}