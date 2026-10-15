import type { Theme, ThemeTokens } from '../types';
import { baseStyles } from './base';

/** 小红书向：落日橙。标题走荧光笔式涂抹、加粗走主色底高亮——
 * 30px 卡片上中文着重号会变成一排点（基线图实测），高亮更干净。 */
const tokens: ThemeTokens = {
  color: '#d9480f',
  fontFamily: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
  fontSize: '36px',
  lineHeight: '1.75',
  radius: '12px',
  ink: '#2a2320',
  inkSoft: '#574c46',
  muted: '#93877f',
  headInk: '#1d1512',
  quoteInk: '#463b35',
  canvasBg: '#fff6f1',
  codeBg: '#fbeee6',
  codeInk: '#2a2320',
  imgRadius: '14px',
  letterSpacing: '0.03em',
  paraSpacing: '0.62em',
  sectionSpacing: '1.1em',
  align: 'left',

  // 样式开关：决定 derivedSlots 产出哪一套装饰（主题不手写装饰槽，见 base.ts 头注）
  headingStyle: 'underline-highlight',
  quoteStyle: 'left-bar',
  strongStyle: 'highlight',
  codeBar: 'mac',
  tableStyle: 'card',
  listStyle: 'cjk-numeral',
  hrStyle: 'dots',
};

export const mucheng: Theme = {
  id: 'mucheng',
  name: '暮橙',
  platform: 'xhs',
  dark: undefined,
  tokens,
  /**
   * 卡片视觉身份：底纹 + 装饰件。
   * 有了这两层，卡片才不是"一块底色加一段字"——纸感与贴边物件给的是身份。
   */
  cardChrome: {
    texture: 'kraft',
    deco: 'magazine',
    textureInk: '#b5765a',
    textureOpacity: 0.9,
  },
  styles: baseStyles({ card: true }),
};
