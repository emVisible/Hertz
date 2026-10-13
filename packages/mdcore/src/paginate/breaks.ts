/*
 * 断行规则（中文避头尾 + 英文不拆词）
 * 移植自 mdsea/xiaohongshu-text-layout/js/markdown.js 的 adjustBreak/codeBreak，
 * 重写为 TypeScript。原文件 MIT License，Copyright (c) 2025-present Yutong Wu，
 * 许可全文见 mdsea/xiaohongshu-text-layout/LICENSE。
 */

/** 不能出现在行首的标点（避头） */
export const NO_START = '，。、！？；：,.!?;:)）]】」』”’》〉…—～%％·';
/** 不能出现在行尾的标点（避尾） */
export const NO_END = '（([【「『“‘《〈';
/** 英文单词字符 */
const WORD = /[A-Za-z0-9'’\-_.@]/;

/**
 * 跨页拆分段落时调整断点 k（text 的第 k 个字符将成为下一页开头）：
 * 下一页不以「，。」等闭标点开头，前一页不以「（「」等开标点结尾，
 * 也不把英文单词拦腰截断。
 */
export function adjustBreak(text: string, k: number): number {
  if (k <= 0 || k >= text.length) return k;
  let j = k;
  for (let n = 0; n < 3 && j > 1; n++) {
    if (NO_START.includes(text[j]) || NO_END.includes(text[j - 1])) j--;
    else break;
  }
  if (WORD.test(text[j - 1] || '') && WORD.test(text[j] || '')) {
    let m = j;
    while (m > 0 && j - m < 30 && WORD.test(text[m - 1])) m--;
    if (m > 0 && j - m < 30) j = m;
  }
  return j > 0 ? j : k;
}

/** 代码块尽量在换行处断开 */
export function codeBreak(text: string, k: number): number {
  const nl = text.lastIndexOf('\n', k - 1);
  return nl > 0 ? nl + 1 : k;
}
