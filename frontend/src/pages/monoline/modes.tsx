/** 呈现模式库数据（移植自 monoline web/modes.tsx：28 kinds + 版式变体）。
 *  wireframe 缩略 glyph 为 48x30 内联 SVG 片段，经 dangerouslySetInnerHTML 渲染。
 */
import { createElement } from "react";

export type Mode = { kind: string; zh: string; desc: string; glyph: string };
export type ModeGroup = { id: string; zh: string; note: string; modes: Mode[] };

// Wireframe thumbnails: text rows are strokes, panels are outlined rects, and one
// element per glyph carries .mg-a so it picks up the accent colour. Coordinates are
// in a 48×30 box (the 16:10 canvas), so they read as a scaled-down slide, not an icon.
export const MODE_GROUPS: ModeGroup[] = [
  {
    id: "text", zh: "文字与叙事", note: "把一句话当成画面主角", modes: [
      { kind: "title", zh: "封面", desc: "标签 + 大标题 + 副标题，开场第一帧", glyph:
        '<line x1="8" y1="9" x2="17" y2="9" class="mg-a" stroke-width="1.4"/><line x1="8" y1="15" x2="34" y2="15" stroke-width="2.6"/><line x1="8" y1="22" x2="25" y2="22" stroke-width="1.4"/>' },
      { kind: "statement", zh: "金句", desc: "顶部短划 + 居中特大字号断言", glyph:
        '<line x1="20" y1="7" x2="28" y2="7" class="mg-a" stroke-width="2"/><line x1="11" y1="15" x2="37" y2="15" stroke-width="2.6"/><line x1="15" y1="22" x2="33" y2="22" stroke-width="2.6"/>' },
      { kind: "section", zh: "章节", desc: "序号 + 标题，段落之间的分隔页", glyph:
        '<rect x="7" y="8" width="8" height="11" rx="1.5" class="mg-a"/><line x1="20" y1="12" x2="41" y2="12" stroke-width="2.4"/><line x1="20" y1="22" x2="33" y2="22" stroke-width="1.4"/>' },
      { kind: "definition", zh: "术语", desc: "词条 + 释义，解释一个概念", glyph:
        '<line x1="8" y1="10" x2="21" y2="10" class="mg-a" stroke-width="2.6"/><line x1="8" y1="18" x2="40" y2="18" stroke-width="1.4"/><line x1="8" y1="24" x2="31" y2="24" stroke-width="1.4"/>' },
      { kind: "summary", zh: "收束", desc: "眉题 + 结语，用于一节或全片的落点", glyph:
        '<line x1="8" y1="8" x2="16" y2="8" class="mg-a" stroke-width="1.4"/><line x1="8" y1="15" x2="39" y2="15" stroke-width="2.6"/><line x1="8" y1="23" x2="28" y2="23" stroke-width="2.6"/>' },
      { kind: "quote", zh: "引言", desc: "左竖线引出的引号段 + 出处", glyph:
        '<line x1="8" y1="8" x2="8" y2="19" class="mg-a" stroke-width="2"/><line x1="13" y1="10" x2="40" y2="10" stroke-width="2"/><line x1="13" y1="16" x2="33" y2="16" stroke-width="2"/><line x1="13" y1="24" x2="24" y2="24" stroke-width="1.4"/>' },
      { kind: "poster", zh: "文献卡", desc: "标签页纸卡 + 荧光笔高亮 + 落款", glyph:
        '<rect x="9" y="9" width="30" height="16" rx="2"/><rect x="13" y="5" width="11" height="4" rx="1" class="mg-a"/><line x1="13" y1="15" x2="28" y2="15" stroke-width="2.4"/><line x1="13" y1="20.5" x2="22" y2="20.5" stroke-width="1.4"/>' },
      { kind: "note", zh: "旁注", desc: "标记符 + 一句补充说明", glyph:
        '<circle cx="10" cy="11" r="3.4" class="mg-a"/><line x1="17" y1="10" x2="40" y2="10" stroke-width="1.6"/><line x1="17" y1="18" x2="31" y2="18" stroke-width="1.6"/><line x1="17" y1="24" x2="26" y2="24" stroke-width="1.6"/>' },
      { kind: "split", zh: "双栏", desc: "左侧提要撑住，右侧正文解释", glyph:
        '<rect x="5" y="9" width="17" height="13" rx="2" class="mg-a"/><line x1="27" y1="9" x2="43" y2="9" stroke-width="1.6"/><line x1="27" y1="15" x2="41" y2="15" stroke-width="1.6"/><line x1="27" y1="21" x2="37" y2="21" stroke-width="1.6"/><line x1="24" y1="6" x2="24" y2="25" stroke-width="1.2"/>' },
    ],
  },
  {
    id: "enumerate", zh: "清单与对照", note: "把并列内容排稳", modes: [
      { kind: "list", zh: "清单", desc: "标题 + 项目符号，逐条揭示", glyph:
        '<line x1="8" y1="7" x2="26" y2="7" stroke-width="2"/><circle cx="9.5" cy="13.5" r="1.3"/><line x1="13" y1="13.5" x2="41" y2="13.5" stroke-width="1.4"/><circle cx="9.5" cy="19.5" r="1.3" class="mg-a"/><line x1="13" y1="19.5" x2="36" y2="19.5" stroke-width="1.4"/><circle cx="9.5" cy="25.5" r="1.3"/><line x1="13" y1="25.5" x2="30" y2="25.5" stroke-width="1.4"/>' },
      { kind: "cards", zh: "卡片", desc: "标题 + 名称/说明卡片行", glyph:
        '<line x1="7" y1="7" x2="23" y2="7" stroke-width="2"/><rect x="7" y="11" width="16" height="7.5" rx="1.5"/><rect x="25" y="11" width="16" height="7.5" rx="1.5" class="mg-a"/><rect x="7" y="20.5" width="16" height="7.5" rx="1.5"/><rect x="25" y="20.5" width="16" height="7.5" rx="1.5"/>' },
      { kind: "table", zh: "数据表", desc: "名称 + 数值，条形按最大值归一", glyph:
        '<line x1="8" y1="7" x2="41" y2="7" class="mg-a" stroke-width="1.4"/><line x1="8" y1="13.2" x2="16" y2="13.2" stroke-width="1.4"/><rect x="20" y="11.7" width="19" height="3" rx="1.5"/><line x1="8" y1="19.2" x2="16" y2="19.2" stroke-width="1.4"/><rect x="20" y="17.7" width="12" height="3" rx="1.5"/><line x1="8" y1="25.2" x2="16" y2="25.2" stroke-width="1.4"/><rect x="20" y="23.7" width="7" height="3" rx="1.5"/>' },
      { kind: "compare", zh: "对照", desc: "左右两栏 + 中间分界", glyph:
        '<rect x="6" y="8" width="16" height="16" rx="2"/><rect x="26" y="8" width="16" height="16" rx="2"/><line x1="24" y1="5" x2="24" y2="27" class="mg-a" stroke-dasharray="2 2.4"/><line x1="9" y1="13" x2="19" y2="13" stroke-width="1.4"/><line x1="29" y1="13" x2="39" y2="13" stroke-width="1.4"/>' },
    ],
  },
  {
    id: "data", zh: "数据可视化", note: "数字自己会说话", modes: [
      { kind: "stat", zh: "焦点数", desc: "单个巨幅数字 + 单位 + 涨跌", glyph:
        '<line x1="8" y1="13" x2="26" y2="13" class="mg-a" stroke-width="4.6"/><line x1="29" y1="13" x2="35" y2="13" stroke-width="2.4"/><line x1="8" y1="22" x2="28" y2="22" stroke-width="1.4"/>' },
      { kind: "kpi", zh: "指标盘", desc: "多个指标成格，各带涨跌", glyph:
        '<rect x="6" y="7" width="17" height="8.5" rx="1.5"/><rect x="25" y="7" width="17" height="8.5" rx="1.5" class="mg-a"/><rect x="6" y="17.5" width="17" height="8.5" rx="1.5"/><rect x="25" y="17.5" width="17" height="8.5" rx="1.5"/><line x1="9" y1="11.5" x2="15" y2="11.5" stroke-width="2"/><line x1="28" y1="22" x2="34" y2="22" stroke-width="2"/>' },
      { kind: "bars", zh: "条形", desc: "横向条形排名，最大值为满格", glyph:
        '<rect x="8" y="7" width="26" height="3.6" rx="1.8"/><rect x="8" y="13.2" width="17" height="3.6" rx="1.8" class="mg-a"/><rect x="8" y="19.4" width="22" height="3.6" rx="1.8"/>' },
      { kind: "share", zh: "占比", desc: "环形进度 + 百分比中心读数", glyph:
        '<circle cx="16" cy="15" r="8"/><path d="M16 7A8 8 0 0 1 23 18.9" class="mg-a" stroke-width="3"/><line x1="29" y1="11" x2="41" y2="11" stroke-width="1.4"/><line x1="29" y1="16" x2="38" y2="16" stroke-width="1.4"/><line x1="29" y1="21" x2="35" y2="21" stroke-width="1.4"/>' },
      { kind: "trend", zh: "趋势", desc: "迷你折线 + 峰值标注", glyph:
        '<polyline points="7,23 14,16 20,19 27,9 34,14 41,6" class="mg-a" stroke-width="1.8"/><circle cx="27" cy="9" r="1.7"/>' },
      { kind: "funnel", zh: "漏斗", desc: "逐层收窄，宽度按真实数值", glyph:
        '<path d="M9 6h30l-5 5.6H14z" class="mg-a"/><path d="M14.5 13.4h19l-4 5.6H18.5z"/><path d="M19 20.8h10l-2.6 5.2h-4.8z"/>' },
    ],
  },
  {
    id: "structure", zh: "结构与图形", note: "关系画出来，不写出来", modes: [
      { kind: "flow", zh: "流程", desc: "节点顺序连接，讲链路", glyph:
        '<rect x="4" y="11" width="10" height="8" rx="2"/><rect x="19" y="11" width="10" height="8" rx="2" class="mg-a"/><rect x="34" y="11" width="10" height="8" rx="2"/><line x1="15" y1="15" x2="18" y2="15" stroke-width="1.4"/><line x1="30" y1="15" x2="33" y2="15" stroke-width="1.4"/>' },
      { kind: "steps", zh: "步骤", desc: "编号步骤，讲做法", glyph:
        '<circle cx="10" cy="15" r="3.6" class="mg-a"/><circle cx="24" cy="15" r="3.6"/><circle cx="38" cy="15" r="3.6"/><line x1="14.2" y1="15" x2="19.8" y2="15" stroke-width="1.4"/><line x1="28.2" y1="15" x2="33.8" y2="15" stroke-width="1.4"/>' },
      { kind: "timeline", zh: "时间轴", desc: "横轴刻度 + 错落事件", glyph:
        '<line x1="6" y1="22" x2="42" y2="22" class="mg-a" stroke-width="1.6"/><circle cx="13" cy="22" r="1.8"/><circle cx="24" cy="22" r="1.8"/><circle cx="35" cy="22" r="1.8"/><line x1="13" y1="19" x2="13" y2="12" stroke-width="1.4"/><line x1="24" y1="19" x2="24" y2="8" stroke-width="1.4"/><line x1="35" y1="19" x2="35" y2="13" stroke-width="1.4"/>' },
      { kind: "radial", zh: "导图", desc: "中心概念放射分支，分支可带截图", glyph:
        '<circle cx="24" cy="15" r="4" class="mg-a"/><circle cx="9" cy="8" r="2.4"/><circle cx="9" cy="22" r="2.4"/><circle cx="39" cy="8" r="2.4"/><circle cx="39" cy="22" r="2.4"/><path d="M20.6 12.8 11.1 9.2M20.6 17.2l-9.5 3.6M27.4 12.8l9.5-3.6M27.4 17.2l9.5 3.6" stroke-width="1.4"/>' },
      { kind: "cycle", zh: "循环", desc: "节点坐在圆环上，讲闭环", glyph:
        '<circle cx="24" cy="15" r="9" stroke-dasharray="3 3" class="mg-a"/><circle cx="24" cy="6" r="2.4"/><circle cx="32" cy="19.5" r="2.4"/><circle cx="16" cy="19.5" r="2.4"/>' },
      { kind: "arch", zh: "分层", desc: "自上而下的层次堆叠", glyph:
        '<rect x="9" y="5" width="30" height="5.8" rx="1.5" class="mg-a"/><rect x="9" y="12.1" width="30" height="5.8" rx="1.5"/><rect x="9" y="19.2" width="30" height="5.8" rx="1.5"/>' },
      { kind: "matrix", zh: "象限", desc: "双轴 2×2 定位", glyph:
        '<line x1="24" y1="5" x2="24" y2="27" stroke-width="1.4"/><line x1="8" y1="15" x2="42" y2="15" stroke-width="1.4"/><rect x="11" y="7.5" width="9" height="5" rx="1"/><rect x="28" y="17.5" width="9" height="5" rx="1" class="mg-a"/>' },
    ],
  },
  {
    id: "media", zh: "素材", note: "真实画面进场", modes: [
      { kind: "image", zh: "图片", desc: "相框 + 统一色调 + 缓慢推拉", glyph:
        '<rect x="7" y="7" width="34" height="18" rx="2"/><path d="M11 21.4l6.4-7.2 4.2 4.6 4.2-5.2 5.2 7.8z" class="mg-a"/><circle cx="16" cy="12.4" r="1.7"/>' },
      { kind: "showcase", zh: "图片卡行", desc: "并排的截图卡，各带名称与说明", glyph:
        '<rect x="4" y="8" width="12" height="11" rx="1.5"/><rect x="18" y="8" width="12" height="11" rx="1.5" class="mg-a"/><rect x="32" y="8" width="12" height="11" rx="1.5"/><line x1="4" y1="23" x2="13" y2="23" stroke-width="1.6"/><line x1="18" y1="23" x2="27" y2="23" stroke-width="1.6"/><line x1="32" y1="23" x2="41" y2="23" stroke-width="1.6"/>' },
    ],
  },
];

// The content-free treatment axis from rotation.py: same kind, different setting.
// Kept here rather than imported from the API because the inspector needs it while the
// user is choosing, and test_rotation_variants_match_the_frontend_registry proves the
// two sides do not drift.
export const VARIANTS: { id: string; zh: string }[] = [
  { id: "hero", zh: "居中" },
  { id: "flush", zh: "满栏" },
  { id: "frame", zh: "卡框" },
];
export const VARIANT_KINDS = ["statement", "summary", "quote"];

export const MODES: Record<string, Mode> = Object.fromEntries(
  MODE_GROUPS.flatMap((g) => g.modes).map((m) => [m.kind, m]));
export const MODE_COUNT = Object.keys(MODES).length;

export function ModeGlyph({ body, w = 96, h = 60 }: { body: string; w?: number; h?: number }) {
  return createElement("svg", {
    viewBox: "0 0 48 30", width: w, height: h, fill: "none", stroke: "currentColor",
    strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true,
    className: "mode-glyph", dangerouslySetInnerHTML: { __html: body },
  });
}

/** Catalogue of every presentation mode. The <select> it replaces could not
 *  answer "how many looks do I actually have?" — this can. */
