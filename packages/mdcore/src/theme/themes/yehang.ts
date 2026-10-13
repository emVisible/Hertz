import type { Theme, ThemeTokens } from '../types';
import { baseStyles } from './base';

/** 小红书向深色款：夜航蓝。引用用四角框、代码带 Mac 三色点——技术向长文在深色卡片里更耐读。 */
const tokens: ThemeTokens = {
  color: '#6ea8fe',
  fontFamily: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
  fontSize: '30px',
  lineHeight: '1.6',
  radius: '12px',
  ink: '#e6eaf2',
  inkSoft: '#aab4c6',
  muted: '#7b869a',
  headInk: '#f2f6ff',
  quoteInk: '#c8d2e2',
  canvasBg: '#10131c',
  codeBg: '#181d29',
  codeInk: '#e6eaf2',
  imgRadius: '14px',
  letterSpacing: '0.025em',
  paraSpacing: '0.62em',
  sectionSpacing: '1.1em',
  align: 'left',

  // 样式开关：决定 derivedSlots 产出哪一套装饰（主题不手写装饰槽，见 base.ts 头注）
  headingStyle: 'left-bar',
  quoteStyle: 'corner-frame',
  strongStyle: 'color',
  codeBar: 'mac',
  tableStyle: 'card',
  listStyle: 'marker-color',
  hrStyle: 'pill',
};

export const yehang: Theme = {
  id: 'yehang',
  name: '夜航',
  platform: 'xhs',
  dark: true,
  tokens,
  styles: baseStyles({ dark: true, card: true }),
};
