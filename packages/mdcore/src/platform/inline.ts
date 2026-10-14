/**
 * 平台适配共享层（§3）：微信（§3.1）与知乎（§3.2 降级渲染器）共用的
 * 「渲染态快照内联 → 清洗 → 序列化」基础件。规则与 wechat.ts 抽提前逐字一致，
 * wechat 现有测试即回归证据。
 *
 * 参考声明：快照内联白名单、pre 空格/Tab → &nbsp;、剥 class/id/<style> 等
 * 清洗器对抗思路参考了 mdsea/WeMD（MIT License）的规则清单，代码为本仓库重写。
 */

/** 渲染态快照内联白名单（getComputedStyle 逐节点写回 style） */
export const STYLE_WHITELIST = [
  'color',
  'background',
  'background-color',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'text-align',
  'text-decoration',
  'text-indent',
  'line-height',
  'letter-spacing',
  'margin',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'padding',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'border',
  'border-top',
  'border-right',
  'border-bottom',
  'border-left',
  'border-radius',
  'border-collapse',
  'display',
  'width',
  'max-width',
  'vertical-align',
  'white-space',
  'overflow-x',
  'list-style-type',
];

/**
 * 输入归一化 + 深克隆 + 临时挂载（Chromium 下 getComputedStyle 对脱离文档的
 * 元素返回空值；同步挂载再摘除，不触发绘制。jsdom 对脱离态可读内联样式，无害）。
 * 不改动入参 DOM：全程在克隆上操作，cleanup() 摘除临时挂载。
 */
export function snapshotClone(
  input: Document | HTMLElement,
  label: string,
): { clone: HTMLElement; win: Window; cleanup: () => void } {
  const source: HTMLElement = 'documentElement' in input ? (input.body as HTMLElement) : input;
  if (!source) throw new Error(`@hertz/mdcore: ${label} 需要非空 DOM`);
  const doc = source.ownerDocument;
  const win = doc.defaultView;
  if (!win) throw new Error('@hertz/mdcore: DOM 缺少 defaultView');

  const clone = source.cloneNode(true) as HTMLElement;
  const needAttach = !clone.isConnected && !!doc.documentElement;
  if (needAttach) doc.documentElement.appendChild(clone);
  return {
    clone,
    win,
    cleanup: () => {
      if (needAttach) clone.remove();
    },
  };
}

/** 渲染态快照内联 —— 白名单 CSS 属性逐节点写回 style（空值/var() 跳过） */
export function inlineComputedStyles(root: HTMLElement, win: Window): void {
  const visit = (el: Element): void => {
    const htmlEl = el as HTMLElement;
    if (htmlEl.style) {
      let computed: CSSStyleDeclaration | null = null;
      try {
        computed = win.getComputedStyle(htmlEl);
      } catch {
        computed = null;
      }
      if (computed) {
        for (const prop of STYLE_WHITELIST) {
          const value = computed.getPropertyValue(prop);
          // jsdom 对不支持的属性返回 '' —— 跳过；var() 残留不写入
          if (!value || value.includes('var(')) continue;
          htmlEl.style.setProperty(prop, value);
        }
      }
    }
    for (const child of Array.from(el.children)) visit(child);
  };
  visit(root);
}

/** 清洗器对抗 —— pre 内空格/Tab → nbsp；pre overflow-x:auto；code 左对齐 */
export function hardenCodeBlocks(root: HTMLElement): void {
  const doc = root.ownerDocument;
  for (const pre of Array.from(root.querySelectorAll('pre'))) {
    const walker = doc.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
    const texts: Text[] = [];
    while (walker.nextNode()) texts.push(walker.currentNode as Text);
    for (const node of texts) {
      node.data = node.data.replace(/ /g, '\u00a0').replace(/\t/g, '\u00a0\u00a0\u00a0\u00a0');
    }
    pre.style.setProperty('overflow-x', 'auto');
  }
  for (const code of Array.from(root.querySelectorAll('code'))) {
    code.style.setProperty('text-align', 'left');
  }
}

/**
 * 图片地址白名单（进剪贴板前最后一道）。
 *
 * markdown-it 侧已经放过 `data:image/*`，但产物里也可能出现手写 HTML 的 `<img>`；
 * 微信/知乎会把这段 HTML 原样粘进第三方编辑器，所以这里按参考实现（xhs 布局仓
 * `safeImageSrc`）的白名单再筛一遍：只留 http(s)、data:image/(位图)、不含 `..` 的相对路径。
 * 其余换成 1×1 透明占位——**不静默删图**：删掉的话用户看不出"图没了"，
 * 而占位至少说明这里本该有图。
 */
const TRANSPARENT_PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

export function sanitizeImageSources(root: HTMLElement): void {
  for (const img of Array.from(root.querySelectorAll('img'))) {
    const src = (img.getAttribute('src') ?? '').trim();
    const ok =
      /^https?:\/\//i.test(src) ||
      /^data:image\/(png|jpe?g|gif|webp|bmp|avif)[;,]/i.test(src) ||
      (src !== '' && !/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(src) && !src.includes('..'));
    if (!ok) img.setAttribute('src', TRANSPARENT_PX);
  }
}

/** 剥除 class/id、空 style、含 var() 的声明（CSS 变量已全部展开为字面值） */
export function stripUnsafe(root: HTMLElement): void {
  const all = [root, ...Array.from(root.querySelectorAll('*'))];
  for (const el of all) {
    el.removeAttribute('class');
    el.removeAttribute('id');
    // mdcore 自己的定位标记（画布交互用）不进产物：它们是编辑器状态，不是排版结果
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.startsWith('data-mdcore-')) el.removeAttribute(attr.name);
    }
    const htmlEl = el as HTMLElement;
    if (htmlEl.style) {
      for (const prop of Array.from({ length: htmlEl.style.length }, (_, i) => htmlEl.style.item(i))) {
        if (htmlEl.style.getPropertyValue(prop).includes('var(')) {
          htmlEl.style.removeProperty(prop);
        }
      }
      if (!htmlEl.getAttribute('style')?.trim()) htmlEl.removeAttribute('style');
    }
  }
}

/** 换标签保留属性与子节点（结构扁平化的基础操作） */
export function replaceTag(el: Element, tag: string): void {
  const doc = el.ownerDocument;
  const next = doc.createElement(tag);
  for (const attr of Array.from(el.attributes)) {
    next.setAttribute(attr.name, attr.value);
  }
  while (el.firstChild) next.appendChild(el.firstChild);
  el.replaceWith(next);
}

export function normalizeText(root: HTMLElement): string {
  return (root.textContent ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 复制到剪贴板：ClipboardItem 双写 text/html + text/plain，降级 execCommand（§3.1）。
 * 微信/知乎共用同一份双写逻辑。
 */
export async function copyToClipboard(payload: { html: string; text: string }): Promise<void> {
  const nav = globalThis.navigator;
  const ClipboardItemCtor = (globalThis as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
  let firstError: Error | undefined;

  if (nav?.clipboard && typeof nav.clipboard.write === 'function' && ClipboardItemCtor) {
    const item = new ClipboardItemCtor({
      'text/html': new Blob([payload.html], { type: 'text/html' }),
      'text/plain': new Blob([payload.text], { type: 'text/plain' }),
    });
    try {
      await nav.clipboard.write([item]);
      return;
    } catch (e) {
      // 焦点丢失 / 权限被拒等瞬时错误不该直接放弃：继续走下面的降级链，
      // 全链都失败时再抛（保留原始原因）。
      firstError = e as Error;
    }
  }

  // 降级：execCommand 复制富文本
  const doc = globalThis.document;
  if (doc && typeof doc.execCommand === 'function') {
    const holder = doc.createElement('div');
    holder.setAttribute('contenteditable', 'true');
    holder.style.setProperty('position', 'fixed');
    holder.style.setProperty('left', '-9999px');
    holder.innerHTML = payload.html;
    doc.body.appendChild(holder);
    try {
      const range = doc.createRange();
      range.selectNodeContents(holder);
      const sel = doc.defaultView?.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      const ok = doc.execCommand('copy');
      sel?.removeAllRanges();
      if (ok) return;
    } finally {
      holder.remove();
    }
  }

  // 最后兜底：纯文本
  if (nav?.clipboard && typeof nav.clipboard.writeText === 'function') {
    try {
      await nav.clipboard.writeText(payload.text);
      return;
    } catch (e) {
      // 报第一个原因（多为「窗口未聚焦」），它比末端的权限错误更可行动
      throw firstError ?? (e as Error);
    }
  }
  throw firstError ?? new Error('@hertz/mdcore: 当前环境无可用剪贴板 API');
}
