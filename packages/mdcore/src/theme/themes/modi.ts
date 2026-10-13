import type { Theme, ThemeTokens } from '../types';
import { baseStyles } from './base';

/** 微信向清爽款：青绿主色、左边条标题、短短的分隔线。正文两端对齐，不缩进（移动端缩进反而不习惯）。 */
const tokens: ThemeTokens = {
  color: '#0f766e',
  fontFamily: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
  fontSize: '16px',
  lineHeight: '1.8',
  radius: '6px',
  ink: '#2b2b2b',
  inkSoft: '#5a5a5a',
  muted: '#8c8c8c',
  headInk: '#12241c',
  quoteInk: '#4a4a4a',
  canvasBg: '#ffffff',
  codeBg: '#f6f6f4',
  codeInk: '#2b2b2b',
  imgRadius: '6px',
  letterSpacing: '0.02em',
  paraSpacing: '1em',
  sectionSpacing: '1.6em',
  align: 'justify',

  // 样式开关：决定 derivedSlots 产出哪一套装饰（主题不手写装饰槽，见 base.ts 头注）
  headingStyle: 'left-bar',
  quoteStyle: 'left-bar',
  strongStyle: 'color',
  codeBar: 'lang',
  tableStyle: 'card',
  listStyle: 'marker-color',
  hrStyle: 'short',
};

export const modi: Theme = {
  id: 'modi',
  name: '墨滴',
  platform: 'wechat',
  dark: undefined,
  tokens,
  styles: baseStyles(),
};
