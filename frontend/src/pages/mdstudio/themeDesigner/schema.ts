/**
 * 主题设计器的 token 清单：36 个变量、10 个分区（v0.36 Phase 3）。
 *
 * 为什么是「清单」而不是在组件里 if/else 摆控件：
 * 设计器要同时满足三件事——①每个变量有中文名与控件类型；②派生变量（accentInk/
 * soft/rule/hl 由主色算）要标出来让人知道它跟着主色走；③判据要能证明**清单
 * 覆盖了 token 的全集，一个不漏一个不多**。写成清单这三件都是可判的；写成
 * 组件里的分支，就只剩"界面里看着全不全"。
 *
 * `TOKEN_DESCRIPTORS` 与 mdcore 的 `ResolvedTokens` 键集必须相等，由
 * schema.test.ts 守死：加 token 忘了补界面，那条判据立刻红。
 */
import {
  CODE_BARS,
  CODE_THEMES,
  HEADING_STYLES,
  HR_STYLES,
  LIST_STYLES,
  QUOTE_STYLES,
  STRONG_STYLES,
  TABLE_STYLES,
  type ResolvedTokens,
} from '@hertz/mdcore'

export type TokenKey = keyof ResolvedTokens

/** 控件类型：色板 / 文本（含数值与单位）/ 枚举 */
export type TokenControl = 'color' | 'text' | 'select'

export interface TokenDescriptor {
  key: TokenKey
  /** 中文名（设计器界面的主标签） */
  label: string
  /** 一句话说明这个变量管什么 */
  hint: string
  control: TokenControl
  /** select 的候选项 */
  options?: readonly string[]
  /**
   * 由主色派生（accentInk/soft/rule/hl）——界面上标「跟随主色」，
   * 用户手动改过之后改标「已固定」，并给一个还原按钮。
   */
  derived?: boolean
  /** 预设快捷值（文本/色板控件用） */
  presets?: readonly string[]
}

export interface TokenSection {
  id: string
  label: string
  hint: string
  tokens: readonly TokenDescriptor[]
}

const CJK_FONTS = [
  "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
  "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
  "'Songti SC', 'SimSun', serif",
  "'Kaiti SC', 'STKaiti', serif",
  "'FangSong', 'STFangsong', serif",
  "Georgia, 'Times New Roman', 'Songti SC', serif",
  "'Hiragino Sans GB', 'Microsoft YaHei', 'PingFang SC', sans-serif",
]

export const TOKEN_SECTIONS: readonly TokenSection[] = [
  {
    id: 'ink',
    label: '墨色',
    hint: '五层灰阶。层级靠这层拉开，不是靠装饰。',
    tokens: [
      { key: 'ink', label: '正文', hint: '正文主色，占屏最多的一层', control: 'color' },
      { key: 'inkSoft', label: '次要', hint: '说明、图注、列表项', control: 'color' },
      { key: 'muted', label: '弱辅助', hint: '分隔线旁、页脚、免责声明', control: 'color' },
      { key: 'headInk', label: '标题', hint: '比正文更重，标题才立得住', control: 'color' },
      { key: 'quoteInk', label: '引用', hint: '引用块通常比正文淡一档', control: 'color' },
    ],
  },
  {
    id: 'accent',
    label: '主色族',
    hint: '换主色整套跟着走；派生项可单独固定。',
    tokens: [
      { key: 'color', label: '主色', hint: '序号、链接、强调、装饰线都跟它', control: 'color' },
      {
        key: 'accentInk',
        label: '主色底文字',
        hint: '主色实底上的字色，由对比度算出来',
        control: 'color',
        derived: true,
      },
      { key: 'soft', label: '主色淡底', hint: '引用/表格/提示块的底', control: 'color', derived: true },
      { key: 'rule', label: '描边', hint: '边框、分隔线', control: 'color', derived: true },
      { key: 'hl', label: '荧光底', hint: '==高亮== 的底色', control: 'color', derived: true },
      { key: 'codeBg', label: '代码底', hint: '代码块与行内代码的底', control: 'color' },
      { key: 'codeInk', label: '代码字色', hint: '代码块正文颜色', control: 'color' },
      { key: 'canvasBg', label: '画布底', hint: '卡片与画布自身，小红书卡片走它', control: 'color' },
    ],
  },
  {
    id: 'font',
    label: '字体与字号',
    hint: '中文排版八成的问题出在这一区。',
    tokens: [
      { key: 'fontFamily', label: '正文字族', hint: '中文正文的主字体栈', control: 'select', options: CJK_FONTS },
      { key: 'fontHead', label: '标题字族', hint: '留空则与正文同族', control: 'select', options: ['', ...CJK_FONTS] },
      {
        key: 'fontMono',
        label: '等宽字族',
        hint: '代码块',
        control: 'text',
        presets: ["'SFMono-Regular', Consolas, Menlo, 'Courier New', monospace"],
      },
      { key: 'fontSize', label: '字号', hint: '正文基准；间距全是 em，改字号会自动跟着缩放', control: 'text', presets: ['14px', '15px', '16px', '17px', '18px', '20px'] },
      { key: 'lineHeight', label: '行高', hint: '中文 1.75~1.9 最稳', control: 'text', presets: ['1.5', '1.6', '1.75', '1.9', '2.0'] },
      { key: 'letterSpacing', label: '字距', hint: '中文给 0.02em 上下的小值即可', control: 'text', presets: ['0', '0.01em', '0.02em', '0.05em'] },
    ],
  },
  {
    id: 'rhythm',
    label: '节奏与版面',
    hint: '段距、行长、首行缩进——决定"读起来累不累"。',
    tokens: [
      { key: 'paraSpacing', label: '段距', hint: '段落之间', control: 'text', presets: ['0.8em', '1em', '1.2em', '1.5em'] },
      { key: 'sectionSpacing', label: '章节距', hint: '标题与正文块之间', control: 'text', presets: ['1.25em', '1.5em', '1.75em', '2em'] },
      { key: 'indent', label: '首行缩进', hint: '公众号正文爱缩进，知乎/小红书一般不缩', control: 'select', options: ['0', '2em'] },
      { key: 'align', label: '对齐', hint: '两端对齐在窄栏容易拉出"河流"', control: 'select', options: ['left', 'justify', 'center'] },
      { key: 'measure', label: '行长上限', hint: '正文一行最多多宽（em），太长就该缩窄', control: 'select', options: ['none', '30em', '34em', '38em'] },
    ],
  },
  {
    id: 'depth',
    label: '层级与组件尺寸',
    hint:
      '标题阶跃与各组件的相对字号——这一区以前一个字都没有，于是"正文大一点、图注小一点"这种最常见的比例关系做不出来。',
    tokens: [
      {
        key: 'headingStep',
        label: '标题层递',
        hint: '按级次累除：1 = 原样，越大层级越陡、越小越平',
        control: 'text',
        presets: ['0.9', '0.95', '1', '1.1', '1.2'],
      },
      { key: 'captionSize', label: '图注字号', hint: '相对正文', control: 'text', presets: ['0.72em', '0.78em', '0.82em', '0.88em'] },
      { key: 'quoteSize', label: '引用字号', hint: '相对正文', control: 'text', presets: ['0.92em', '0.97em', '1em'] },
      { key: 'codeSize', label: '代码字号', hint: '行内与块级代码共用这一档', control: 'text', presets: ['0.8em', '0.86em', '0.92em'] },
      { key: 'codeLineHeight', label: '代码行距', hint: '等宽字行距太小会挤成一坨', control: 'text', presets: ['1.45', '1.6', '1.75'] },
      { key: 'tableSize', label: '表格字号', hint: '窄表最需要小一号', control: 'text', presets: ['0.86em', '0.92em', '1em'] },
      { key: 'tableCellPad', label: '单元格内边距', hint: '表格挤不挤全看它', control: 'text', presets: ['0.35em 0.5em', '0.5em 0.7em', '0.7em 1em'] },
      { key: 'listSpacing', label: '列表项间距', hint: '项与项之间', control: 'text', presets: ['0.2em', '0.35em', '0.5em', '0.7em'] },
    ],
  },
  {
    id: 'shape',
    label: '形状',
    hint: '圆角与投影。克制一点，装饰多了层级反而难读。',
    tokens: [
      { key: 'radius', label: '圆角', hint: '卡片与块的圆角', control: 'text', presets: ['0', '4px', '6px', '10px', '14px'] },
      { key: 'imgRadius', label: '图片圆角', hint: '图片通常比块小一号', control: 'text', presets: ['0', '4px', '6px', '10px'] },
      { key: 'border', label: '描边', hint: '块的边框', control: 'text', presets: ['none', '1px solid rgba(0,0,0,0.08)'] },
      { key: 'shadow', label: '投影', hint: '留白不够时用投影代替边框', control: 'text', presets: ['none', '0 1px 2px rgba(0,0,0,0.06)'] },
    ],
  },
  {
    id: 'heading',
    label: '标题装饰',
    hint: '一套稿只用一种标题装饰——每一种都在喊，喊多了就都不响。',
    tokens: [{ key: 'headingStyle', label: '标题样式', hint: '渲染期分支，决定标题挂什么结构', control: 'select', options: HEADING_STYLES }],
  },
  {
    id: 'emphasis',
    label: '强调与引用',
    hint: '加粗、荧光、引用块——中文正文的两个高频表达。',
    tokens: [
      { key: 'strongStyle', label: '加粗样式', hint: '中文加粗笔画易糊，荧光与着重号更稳', control: 'select', options: STRONG_STYLES },
      { key: 'quoteStyle', label: '引用样式', hint: '引用块的结构形态', control: 'select', options: QUOTE_STYLES },
    ],
  },
  {
    id: 'code',
    label: '代码块',
    hint: '技术稿的排版件。',
    tokens: [
      { key: 'codeBar', label: '代码头部', hint: 'mac 窗口条 / 语言标签 / 无', control: 'select', options: CODE_BARS },
      {
        key: 'codeTheme',
        label: '高亮配色',
        hint: '代码 token 的配色预设（Shiki）。深色主题自动换深色版',
        control: 'select',
        options: CODE_THEMES,
      },
    ],
  },
  {
    id: 'table',
    label: '表格',
    hint: '表格是对齐的天敌。',
    tokens: [{ key: 'tableStyle', label: '表格样式', hint: '普通 / 卡片式（斑马纹 + 卡片表头）', control: 'select', options: TABLE_STYLES }],
  },
  {
    id: 'ornament',
    label: '列表与分隔线',
    hint: '收尾的节奏件。',
    tokens: [
      { key: 'listStyle', label: '列表样式', hint: '序号分色 / 中文数字', control: 'select', options: LIST_STYLES },
      { key: 'hrStyle', label: '分隔线', hint: '短横 / 虚线 / 点 / 药丸', control: 'select', options: HR_STYLES },
    ],
  },
]

export const TOKEN_DESCRIPTORS: readonly TokenDescriptor[] = TOKEN_SECTIONS.flatMap((s) => s.tokens)

export function descriptorOf(key: string): TokenDescriptor | undefined {
  return TOKEN_DESCRIPTORS.find((d) => d.key === key)
}

/** 枚举型变量的候选值（含中文说明，界面下拉直接用） */
export const ENUM_LABELS: Record<string, string> = {
  none: '无',
  'left-bar': '左侧竖线',
  'bottom-line': '下划线',
  boxed: '描边框',
  pill: '药丸',
  'underline-highlight': '荧光衬底',
  'double-line': '双线',
  'section-number': '章节编号',
  'top-bottom': '上下横线',
  'quote-mark': '大引号',
  'center-accent': '居中强调',
  'corner-frame': '四角框',
  color: '变色',
  highlight: '荧光块',
  'highlight-bottom': '荧光衬底',
  underline: '下划线',
  dot: '着重号',
  lang: '语言标签',
  mac: 'mac 窗口条',
  plain: '普通',
  card: '卡片式',
  default: '默认',
  'marker-color': '序号分色',
  'cjk-numeral': '中文数字',
  line: '细线',
  short: '短横',
  dashed: '虚线',
  dots: '点线',
  left: '左对齐',
  right: '右对齐',
  justify: '两端对齐',
  center: '居中',
  '0': '不缩进',
  '2em': '缩进两字',
  '30em': '30 字',
  '34em': '34 字',
  '38em': '38 字',
  // 代码高亮预设（P1-5）：proper noun 直接用原名，中文层只说明它是什么
  auto: '跟随主题（GitHub）',
  github: 'GitHub',
  vitesse: 'Vitesse',
  catppuccin: 'Catppuccin',
  dracula: 'Dracula',
  nord: 'Nord',
  'one-dark': 'One Dark',
}