import type { Theme, ThemeTokens } from '../types';
import { baseStyles } from './base';

/** 知乎向：学术风。衬线字族 + 34em 行长上限 + 大引号引用；表格走朴素线框（论文里不该有卡片底色）。 */
const tokens: ThemeTokens = {
  color: '#2f4b7c',
  fontFamily: "Georgia, 'Times New Roman', 'Songti SC', 'STSong', 'SimSun', serif",
  fontHead: "'Songti SC', 'STSong', 'Noto Serif CJK SC', SimSun, serif",
  fontSize: '16px',
  lineHeight: '1.9',
  radius: '4px',
  ink: '#26282b',
  inkSoft: '#4f5459',
  muted: '#868c93',
  headInk: '#1b1f26',
  quoteInk: '#3c4148',
  canvasBg: '#ffffff',
  codeBg: '#f2f4f7',
  codeInk: '#26282b',
  imgRadius: '3px',
  letterSpacing: '0.01em',
  paraSpacing: '0.9em',
  sectionSpacing: '1.6em',
  align: 'justify',
  measure: '34em',

  // 样式开关：决定 derivedSlots 产出哪一套装饰（主题不手写装饰槽，见 base.ts 头注）
  headingStyle: 'bottom-line',
  quoteStyle: 'quote-mark',
  strongStyle: 'color',
  codeBar: 'lang',
  tableStyle: 'plain',
  listStyle: 'default',
  hrStyle: 'line',
};

export const xueshu: Theme = {
  id: 'xueshu',
  name: '学术',
  platform: 'zhihu',
  dark: undefined,
  tokens,
  styles: baseStyles(),
};
