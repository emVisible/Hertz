import type { Theme, ThemeTokens } from '../types';
import { baseStyles } from './base';

/** 知乎向：清简。标题不加任何装饰（知乎编辑器对边框/底色的还原不稳），靠字号与行距拉层级。 */
const tokens: ThemeTokens = {
  color: '#056de8',
  fontFamily: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
  fontSize: '16px',
  lineHeight: '1.75',
  radius: '6px',
  ink: '#24292f',
  inkSoft: '#57606a',
  muted: '#8b949e',
  headInk: '#0d1117',
  quoteInk: '#424a53',
  canvasBg: '#ffffff',
  codeBg: '#f6f8fa',
  codeInk: '#24292f',
  imgRadius: '6px',
  letterSpacing: '0.015em',
  paraSpacing: '0.95em',
  sectionSpacing: '1.5em',
  align: 'justify',
  measure: '34em',

  // 样式开关：决定 derivedSlots 产出哪一套装饰（主题不手写装饰槽，见 base.ts 头注）
  headingStyle: 'none',
  quoteStyle: 'left-bar',
  strongStyle: 'color',
  codeBar: 'lang',
  tableStyle: 'plain',
  listStyle: 'default',
  hrStyle: 'line',
};

export const qingjian: Theme = {
  id: 'qingjian',
  name: '清简',
  platform: 'zhihu',
  dark: undefined,
  tokens,
  styles: baseStyles(),
};
