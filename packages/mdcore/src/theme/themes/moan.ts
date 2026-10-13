import type { Theme, ThemeTokens } from '../types';
import { baseStyles } from './base';

/** 知乎向深色款：墨案。二级标题自动编号（01/02…），加粗走下划线——像一份有目录的研究笔记。 */
const tokens: ThemeTokens = {
  color: '#d4a24c',
  fontFamily: "Georgia, 'Times New Roman', 'Songti SC', 'STSong', 'SimSun', serif",
  fontHead: "'Songti SC', 'STSong', 'Noto Serif CJK SC', SimSun, serif",
  fontSize: '16px',
  lineHeight: '1.9',
  radius: '6px',
  ink: '#e8e2d6',
  inkSoft: '#b3ab9c',
  muted: '#8a8274',
  headInk: '#f7f1e3',
  quoteInk: '#cfc8ba',
  canvasBg: '#16161a',
  codeBg: '#1e1e23',
  codeInk: '#e8e2d6',
  imgRadius: '6px',
  letterSpacing: '0.02em',
  paraSpacing: '1em',
  sectionSpacing: '1.7em',
  align: 'justify',

  // 样式开关：决定 derivedSlots 产出哪一套装饰（主题不手写装饰槽，见 base.ts 头注）
  headingStyle: 'section-number',
  quoteStyle: 'boxed',
  strongStyle: 'underline',
  codeBar: 'mac',
  tableStyle: 'card',
  listStyle: 'marker-color',
  hrStyle: 'short',
};

export const moan: Theme = {
  id: 'moan',
  name: '墨案',
  platform: 'zhihu',
  dark: true,
  tokens,
  styles: baseStyles({ dark: true }),
};
