import type { Theme, ThemeTokens } from '../types';
import { baseStyles } from './base';

/** 小红书向：草绿主色。标题走浅底方框、引用走上下双线——清爽型干货清单的常见观感。 */
const tokens: ThemeTokens = {
  color: '#2f9e44',
  fontFamily: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
  fontSize: '36px',
  lineHeight: '1.75',
  radius: '12px',
  ink: '#22292a',
  inkSoft: '#4d5854',
  muted: '#8a9590',
  headInk: '#16201a',
  quoteInk: '#3f4a46',
  canvasBg: '#f4fbf5',
  codeBg: '#eaf6ec',
  codeInk: '#22292a',
  imgRadius: '14px',
  letterSpacing: '0.02em',
  paraSpacing: '0.6em',
  sectionSpacing: '1.05em',
  align: 'left',

  // 样式开关：决定 derivedSlots 产出哪一套装饰（主题不手写装饰槽，见 base.ts 头注）
  headingStyle: 'boxed',
  quoteStyle: 'top-bottom',
  strongStyle: 'color',
  codeBar: 'lang',
  tableStyle: 'card',
  listStyle: 'marker-color',
  hrStyle: 'dashed',
};

export const qingning: Theme = {
  id: 'qingning',
  name: '青柠',
  platform: 'xhs',
  dark: undefined,
  tokens,
  /**
   * 卡片视觉身份：底纹 + 装饰件。
   * 有了这两层，卡片才不是"一块底色加一段字"——纸感与贴边物件给的是身份。
   */
  cardChrome: {
    texture: 'mesh',
    deco: 'none',
    textureInk: '#4b7f6b',
    textureOpacity: 0.7,
  },
  styles: baseStyles({ card: true }),
};
