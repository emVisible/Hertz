/**
 * 简化版 pangu 预处理（§3.4）：中英文 / 中文数字之间插真实空格。
 * 画布内用 CSS text-autospace，但第三方编辑器（公众号后台）不认 CSS，
 * 进剪贴板前必须插真实空格。自实现简化规则，不引依赖：
 * 仅处理「CJK 字符 ↔ 拉丁字母/数字」边界，不处理标点特例。
 */

// 中日韩统一表意 + 扩展A + 假名 + 兼容表意 + 全角字符
const CJK_RANGE = '\\u2e80-\\u2eff\\u3000-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uff01-\\uff5e';
const ASCII_ALNUM = 'A-Za-z0-9';

const CJK_THEN_ASCII = new RegExp(`([${CJK_RANGE}])([${ASCII_ALNUM}])`, 'g');
const ASCII_THEN_CJK = new RegExp(`([${ASCII_ALNUM}])([${CJK_RANGE}])`, 'g');

export function panguSpacing(text: string): string {
  return text.replace(CJK_THEN_ASCII, '$1 $2').replace(ASCII_THEN_CJK, '$1 $2');
}

/** 对 DOM 文本节点做 pangu；跳过 pre/code（代码内容不许改动） */
export function panguSpacingDOM(root: Element): void {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest('pre, code')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const targets: Text[] = [];
  while (walker.nextNode()) targets.push(walker.currentNode as Text);
  for (const node of targets) {
    node.data = panguSpacing(node.data);
  }
}
