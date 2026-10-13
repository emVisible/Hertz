import type { Theme, ThemeTokens } from '../types';
import { baseStyles } from './base';

/** 小红书向：落日橙。标题走荧光笔式涂抹、加粗用中文着重号（中文正文里比 font-weight 更地道）。 */
const tokens: ThemeTokens = {
  color: '#d9480f',
  fontFamily: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
  fontSize: '30px',
  lineHeight: '1.6',
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
  strongStyle: 'dot',
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
  styles: baseStyles({ card: true }),
};
