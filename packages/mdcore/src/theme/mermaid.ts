/**
 * Mermaid 图表（P2-4 / v0.37）。
 *
 * ## 为什么必须"渲染在前、分页在后"
 *
 * 测量式分页靠 `getBoundingClientRect` 量每个块的高度。`applyTheme` 是**同步**的，
 * 而 mermaid.render 是异步的——如果先把源码文本渲染进页面再量高度，
 * 量到的是**源码的高度**，图表落地后真实高度远大于它，于是卡片溢出、
 * 页脚被顶出去，而且溢出量随图表大小变化，肉眼在预览里先看到"图突然出现"。
 *
 * 所以本模块的契约是：**先异步渲染成 SVG 字符串，交给渲染期同步消费**。
 * `applyTheme(ir, …, { mermaid })` 拿到的 cache 是「源码 → SVG」的映射，
 * 命中就同步落 `<figure>`，于是分页量到的是图的真实高度。
 *
 * ## 失败不静默，但也不留半成品
 *
 * 渲染失败（语法错 / mermaid 没装）→ 记 `render:mermaid` 诊断（横幅里能看到
 * 哪一行），画布上落回**源码代码块**（用户能读、能改）。不落一张空白图框。
 *
 * ## 平台降级：SVG 在微信/知乎是被剥的
 *
 * 两个适配器的 DROP_TAGS 都含 SVG（`platform/wechat.ts`、`platform/zhihu.ts`），
 * 所以粘贴路径必须先把 SVG 栅格化成 dataURL 图片再进清洗——
 * 与知乎表格降级同一套路（`degradeTables` + snapdom 截图）。
 * 栅格化失败同样退回源码，不留空图。
 */
import type { IRBlock, IRDiagnostic } from '../ir/types';
import { mermaidKeyOf } from './mermaidKey';

/** 渲染器：源码 → SVG 字符串；抛错 = 这块渲染失败 */
export type MermaidRenderer = (code: string, id: string) => Promise<string>;

/** SVG 栅格化：SVG 宿主元素 → dataURL 图片（注入点，测试不打真 canvas） */
export type SvgCapture = (el: HTMLElement) => Promise<string>;

export interface MermaidOptions {
  /** 缺省动态 import('mermaid')；测试注入假渲染器 */
  render?: MermaidRenderer | null;
  /** 深色主题用 mermaid 的 dark 配色 */
  dark?: boolean;
}

export interface MermaidResult {
  /** 源码 → SVG（同步渲染期消费） */
  cache: Map<string, string>;
  /** 渲染失败的诊断（`render:mermaid` + 源码行号） */
  diagnostics: IRDiagnostic[];
}

let mermaidId = 0;

function defaultRenderer(dark: boolean): MermaidRenderer {
  let ready: Promise<typeof import('mermaid')['default']> | null = null;
  return async (code: string) => {
    if (!ready) {
      ready = import('mermaid').then((mod) => {
        const mermaid = mod.default;
        mermaid.initialize({
          startOnLoad: false,
          // 图表文字必须落在 SVG 的 <text> 里：foreignObject（HTML 标签）
          // 进不了 canvas 栅格化，而粘贴路径与截图路径都要栅格化
          flowchart: { htmlLabels: false },
          theme: dark ? 'dark' : 'default',
          securityLevel: 'strict',
        });
        return mermaid;
      });
    }
    const mermaid = await ready;
    mermaidId += 1;
    const { svg } = await mermaid.render(`mdcore-mmd-${mermaidId}`, code);
    return svg;
  };
}

/** 取出 IR 里的 mermaid 块（lang 归一化后等于 mermaid） */
export function mermaidBlocksOf(blocks: IRBlock[]): Array<{ block: Extract<IRBlock, { type: 'code' }>; key: string }> {
  const out: Array<{ block: Extract<IRBlock, { type: 'code' }>; key: string }> = [];
  for (const block of blocks) {
    if (block.type !== 'code') continue;
    if ((block.lang ?? '').trim().toLowerCase() !== 'mermaid') continue;
    out.push({ block, key: mermaidKeyOf(block.code) });
  }
  return out;
}

/**
 * 预渲染稿子里的全部 mermaid 块 → `源码 → SVG` cache。
 *
 * 重复源码共用一份 SVG（同一篇稿里常把同一张图放两次）。
 * 一块失败不影响其余：失败项不进 cache（渲染期落回源码），并记诊断。
 */
export async function renderMermaidCache(
  blocks: IRBlock[],
  opts: MermaidOptions = {},
): Promise<MermaidResult> {
  const targets = mermaidBlocksOf(blocks);
  if (!targets.length) return { cache: new Map(), diagnostics: [] };
  const renderer = opts.render === null ? null : (opts.render ?? defaultRenderer(!!opts.dark));
  const cache = new Map<string, string>();
  const diagnostics: IRDiagnostic[] = [];
  if (!renderer) {
    // 明确关掉渲染：不落 cache、不记账（宿主自己说"这次别渲染"）
    return { cache, diagnostics };
  }

  const failures = new Map<string, IRDiagnostic>();
  for (const { block, key } of targets) {
    if (cache.has(key)) continue;
    try {
      cache.set(key, await renderer(block.code, key));
    } catch {
      const line = block.line ? block.line[0] : null;
      const prev = failures.get('render:mermaid');
      if (prev) {
        prev.count += 1;
        if (prev.line === null) prev.line = line;
      } else {
        failures.set('render:mermaid', { token: 'render:mermaid', count: 1, line });
      }
    }
  }
  for (const d of failures.values()) diagnostics.push(d);
  return { cache, diagnostics };
}

/** 默认 SVG 栅格化：snapdom.toBlob → dataURL（与知乎表格截图同一引擎） */
async function defaultSvgCapture(el: HTMLElement): Promise<string> {
  const { snapdom } = await import('@zumer/snapdom');
  const blob = await snapdom.toBlob(el, { type: 'png' });
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(blob);
  });
}

/**
 * 把渲染态 DOM 里的 mermaid `<figure>` 栅格化成 `<img src="dataURL">`。
 *
 * 微信/知乎清洗器剥 SVG，而它们收 `<img>`——所以粘贴路径必须走这一步。
 * 返回成功替换的张数；失败保留原 figure（含 SVG，宿主据此判失败）。
 */
export async function rasterizeMermaid(
  root: ParentNode,
  opts: { capture?: SvgCapture | null } = {},
): Promise<number> {
  const figures = Array.from(root.querySelectorAll('figure.mdcore-mermaid')).filter(
    (el): el is HTMLElement => el instanceof HTMLElement,
  );
  if (!figures.length) return 0;
  const capture = opts.capture === null ? null : (opts.capture ?? defaultSvgCapture);
  if (!capture) return 0;
  const doc = figures[0].ownerDocument ?? globalThis.document;
  let done = 0;
  for (const figure of figures) {
    const svg = figure.querySelector('svg');
    if (!svg) continue;
    let dataUrl: string | null = null;
    try {
      dataUrl = await capture(figure);
    } catch {
      dataUrl = null; // jsdom 无 canvas / 截图失败 → 留原图，宿主降级
    }
    if (!dataUrl) continue;
    const img = doc.createElement('img');
    img.setAttribute('src', dataUrl);
    img.setAttribute('alt', figure.getAttribute('data-mdcore-mermaid-alt') ?? '图表');
    img.style.setProperty('max-width', '100%');
    figure.replaceChildren(img);
    done += 1;
  }
  return done;
}