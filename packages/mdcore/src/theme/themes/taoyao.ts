import type { Theme, ThemeTokens } from '../types';
import { baseStyles } from './base';

/** 小红书向：正红主色 + 圆体标题。药丸式标题与荧光涂抹的加粗是这一套的辨识度；序号用中文数字。 */
const tokens: ThemeTokens = {
  color: '#ff2442',
  fontFamily: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
  fontHead: "'Yuanti SC', 'YouYuan', 'PingFang SC', 'Microsoft YaHei', sans-serif",
  fontSize: '30px',
  lineHeight: '1.55',
  radius: '12px',
  ink: '#2b2b2b',
  inkSoft: '#55504f',
  muted: '#8d8484',
  headInk: '#1f1a1b',
  quoteInk: '#4a4343',
  canvasBg: '#fff5f6',
  codeBg: '#f7ecee',
  codeInk: '#2b2b2b',
  imgRadius: '16px',
  letterSpacing: '0.02em',
  paraSpacing: '0.62em',
  sectionSpacing: '1.1em',
  align: 'left',

  // 样式开关：决定 derivedSlots 产出哪一套装饰（主题不手写装饰槽，见 base.ts 头注）
  headingStyle: 'pill',
  quoteStyle: 'boxed',
  strongStyle: 'highlight-bottom',
  codeBar: 'mac',
  tableStyle: 'card',
  listStyle: 'cjk-numeral',
  hrStyle: 'dots',
};

export const taoyao: Theme = {
  id: 'taoyao',
  name: '桃夭',
  platform: 'xhs',
  dark: undefined,
  tokens,
  styles: baseStyles({ card: true }),
};
