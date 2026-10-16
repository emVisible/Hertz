/**
 * 公式链路的判据（W1 切片 1）。
 *
 * 这一片修的是一条"**说支持、产物里不成立**"的功能：KaTeX 的 CSS 与 @font-face
 * 全仓无人引入，于是公式在画布/导出/剪贴板三条路径上从来都是一堆没有布局的字符。
 *
 * 四种形态都要可判，因为它们对应四种不同的失败：
 * ① 正常渲染（CSS 在、TeX 合法）
 * ② CSS 缺失 → 源码回落（作者看得懂自己写了什么）
 * ③ TeX 非法 → 失败回落（不能给一个红字裸块）
 * ④ 平台强制纯文本（公众号编辑器丢 class 与字体，宁可给源码）
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { applyTheme, parseToIR, wechatPayload, zhihuPayload } from '../index';
import { FORMULA_TEX_ATTR, formulaTexOf, katexCssMissing, renderFormula, resetKatexCssProbe } from './formula';

const require = createRequire(import.meta.url);
const KATEX_CSS = readFileSync(require.resolve('katex/dist/katex.min.css'), 'utf-8');

/** 注入真 KaTeX 样式表（jsdom 没有排版，只能用「有没有 .katex 规则」来验分支） */
function injectKatexCss(): void {
  const style = document.createElement('style');
  style.id = 'katex-css-under-test';
  style.textContent = KATEX_CSS;
  document.head.appendChild(style);
  resetKatexCssProbe();
}

/** jsdom 无布局：给 .katex 一个非零高度，让"CSS 是否加载"的探针说得准 */
function stubKatexLayout(): void {
  const style = document.createElement('style');
  style.id = 'katex-layout-stub';
  style.textContent = '.katex { display: inline-block; }';
  document.head.appendChild(style);
  document.body.style.setProperty('--hz-stub', '1');
  // jsdom 的 getClientRects 恒空，用 CSS 规则 + 尺寸属性把探针骗成"有高度"
  const probeStyle = document.createElement('style');
  probeStyle.textContent = '.katex { height: 10px; }';
  document.head.appendChild(probeStyle);
  const original = Element.prototype.getBoundingClientRect;
  if (!(Element.prototype as unknown as Record<string, unknown>).__katexStub) {
    (Element.prototype as unknown as Record<string, unknown>).__katexStub = true;
    Element.prototype.getBoundingClientRect = function patched(this: Element) {
      if (this.classList?.contains('katex')) {
        return { width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
      }
      return original.call(this);
    };
  }
}

beforeEach(() => {
  resetKatexProbeEnv();
});

afterEach(() => {
  resetKatexProbeEnv();
});

function resetKatexProbeEnv(): void {
  document.getElementById('katex-css-under-test')?.remove();
  document.getElementById('katex-layout-stub')?.remove();
  resetKatexCssProbe();
}

describe('CSS 缺失时的回落（这是此前的真实状态）', () => {
  it('没有 KaTeX 样式表时，公式渲染成可读源码而不是塌掉的字符', () => {
    const el = applyTheme(parseToIR('行内 $a^2+b^2$ 公式'), 'modi');
    const code = el.querySelector('.mdcore-formula-src');
    expect(code).toBeTruthy();
    expect(code?.textContent).toBe('a^2+b^2');
    // 附一句说明，让用户知道这不是他写错了
    expect(el.querySelector('.mdcore-formula-note')?.textContent).toContain('样式表');
  });

  it('块级公式同样回落，且容器带可提取的源码属性', () => {
    const el = applyTheme(parseToIR('$$\n\\int_0^1 x\\,dx\n$$'), 'modi');
    const box = el.querySelector('.mdcore-formula') as HTMLElement;
    expect(box.querySelector('.mdcore-formula-src')).toBeTruthy();
    expect(box.getAttribute(FORMULA_TEX_ATTR)).toContain('\\int_0^1');
  });

  it('源码被转义，不能借这条通道注入标签', () => {
    // 直接调渲染层而不是走 markdown：`$…$` 里的尖括号会先被 markdown 的 HTML
    // 规则摘走，那样测的就不是 escapeHtml 了
    const host = document.createElement('div');
    host.innerHTML = renderFormula('<img src=x onerror=alert(1)>', false, { doc: document }).html;
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('code')?.textContent).toContain('<img');
  });
});

describe('CSS 就位时的正常渲染', () => {
  it('渲染出 KaTeX 结构而不是回落形态', () => {
    injectKatexCss();
    stubKatexLayout();
    expect(katexCssMissing(document)).toBe(false);
    const el = applyTheme(parseToIR('行内 $a^2+b^2$ 公式'), 'modi');
    expect(el.querySelector('.mdcore-formula-src')).toBeNull();
    expect(el.querySelector('.katex')).toBeTruthy();
  });

  it('行内公式有自己的槽（此前是「裸 span 零样式」，主题管不到）', () => {
    injectKatexCss();
    stubKatexLayout();
    const el = applyTheme(parseToIR('行内 $x$ 公式'), 'modi');
    const span = el.querySelector('.mdcore-formula-inline') as HTMLElement;
    expect(span).toBeTruthy();
    expect(span.style.lineHeight).toBe('1');
  });
});

describe('TeX 非法时的失败回落', () => {
  it('给源码 + 明确提示，而不是 KaTeX 自带的一坨红字', () => {
    injectKatexCss();
    stubKatexLayout();
    const el = applyTheme(parseToIR('行内 $\\frac{1}$ 公式'), 'modi');
    const code = el.querySelector('.mdcore-formula-src');
    expect(code).toBeTruthy();
    expect(el.textContent).toContain('公式渲染失败');
    expect(el.querySelector('.katex-error')).toBeNull();
  });
});

describe('平台适配器的源码契约', () => {
  it('属性优先于 class：回落形态没有 .katex class，也要能取到源码', () => {
    const el = applyTheme(parseToIR('行内 $x+y$'), 'modi');
    const span = el.querySelector('.mdcore-formula-inline') as HTMLElement;
    expect(span.classList.contains('katex')).toBe(false);
    expect(formulaTexOf(span)).toBe('x+y');
  });

  it('知乎：回落形态的公式照样被还原成 $$…$$ 源码（此前这里是空白）', async () => {
    const el = applyTheme(parseToIR('$$\nE=mc^2\n$$'), 'modi');
    document.body.appendChild(el);
    try {
      const { text } = await zhihuPayload(el);
      expect(text).toContain('$$E=mc^2$$');
    } finally {
      el.remove();
    }
  });

  it('知乎：行内公式还原成 $…$', async () => {
    const el = applyTheme(parseToIR('正文的 $x^2$ 公式'), 'modi');
    document.body.appendChild(el);
    try {
      const { text } = await zhihuPayload(el);
      expect(text).toContain('$x^2$');
    } finally {
      el.remove();
    }
  });

  /**
   * 微信通道的**保真断言**（P1-2 结构层）：公众号清洗器会剥 @font-face，
   * KaTeX 的 CSS 字体落不了地——落地方案（SVG / 转图）与真机验收都要先在
   * 产物里认出公式、取回原始 TeX。class 是渲染实现，属性才是契约：
   * 其余 data-mdcore-* 编辑器标记照旧剥，唯独公式源码属性必须保真进入产物。
   * 成对变异：去掉 stripUnsafe 里的 FORMULA_TEX_ATTR 例外 → 本条红。
   */
  it('微信：公式携带 data-mdcore-formula-tex 契约进产物（TeX 保真，其余标记仍剥）', () => {
    const el = applyTheme(parseToIR('正文 $x^2$ 与\n\n$$\n\\int_0^1 t\\,dt\n$$'), 'modi');
    document.body.appendChild(el);
    try {
      const { html } = wechatPayload(el);
      const holder = document.createElement('div');
      holder.innerHTML = html;
      const texes = Array.from(holder.querySelectorAll(`[${FORMULA_TEX_ATTR}]`)).map(
        (n) => n.getAttribute(FORMULA_TEX_ATTR) ?? '',
      );
      expect(texes).toHaveLength(2);
      expect(texes[0]).toBe('x^2');
      expect(texes[1]).toContain('\\int_0^1');
      // 编辑器状态标记（块定位/行号）仍然不进产物——例外只给公式契约
      expect(html).not.toContain('data-mdcore-block');
      expect(html).not.toContain('data-mdcore-line');
    } finally {
      el.remove();
    }
  });
});
