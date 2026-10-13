import type { Theme, ThemeTokens } from '../types';
import { baseStyles } from './base';

/** 微信向深色款：琥珀主色配宋体标题，标题走下划线式、加粗走底色高亮。深夜读长文不刺眼。 */
const tokens: ThemeTokens = {
  color: '#e8a04c',
  fontFamily: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
  fontHead: "'Songti SC', 'STSong', 'Noto Serif CJK SC', SimSun, serif",
  fontSize: '16px',
  lineHeight: '1.9',
  radius: '8px',
  ink: '#e6e4e0',
  inkSoft: '#b9b5ad',
  muted: '#8f8b84',
  headInk: '#f6f2ea',
  quoteInk: '#d6d2ca',
  canvasBg: '#17181c',
  codeBg: '#1f2127',
  codeInk: '#e6e4e0',
  imgRadius: '8px',
  letterSpacing: '0.03em',
  paraSpacing: '1.1em',
  sectionSpacing: '1.8em',
  align: 'justify',

  // 样式开关：决定 derivedSlots 产出哪一套装饰（主题不手写装饰槽，见 base.ts 头注）
  headingStyle: 'bottom-line',
  quoteStyle: 'boxed',
  strongStyle: 'highlight',
  codeBar: 'mac',
  tableStyle: 'card',
  listStyle: 'marker-color',
  hrStyle: 'pill',
};

export const wanfeng: Theme = {
  id: 'wanfeng',
  name: '晚风',
  platform: 'wechat',
  dark: true,
  tokens,
  styles: baseStyles({ dark: true }),
};
