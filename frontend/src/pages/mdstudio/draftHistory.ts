/**
 * 文档级撤销/重做（W2 数据安全之一）。
 *
 * CodeMirror 自带文本撤销，但那只覆盖**文字**。而一篇排版稿的"内容"远不止文字：
 * 主题、平台、字号档位、封面、比例、底纹、分页边界……拖一个滑杆就把稿子改了，
 * 而 `Ctrl+Z` 撤不回。用户于是养成"不敢动"的习惯——不敢动样式，就等于产品没做。
 *
 * 这一层管的是 `patchDraft` 的**非文字变更**，两条硬要求：
 *
 * ①**合并同类**：连续拖同一个滑杆产生上百次 patch，逐条入栈会把撤销栈冲垮，
 *    于是用户按一次撤销要按几十次才能回到改动前。所以相邻同类变更在时间窗内合并。
 * ②**撤销必须真的能回到那一步**。CodeMirror 撤销文字后，我们把 `source_md`
 *    也纳入快照——否则"撤销"只撤了样式，文字停在改后的版本，两边对不上。
 *
 * 跨会话的回退不归这里管，那是后端 `layout_revisions`（见 layout.py）。
 */

export interface HistoryEntry<T> {
  /** 这一版的状态 */
  state: T
  /** 什么时候记的（ms） */
  at: number
  /** 用来判断"是不是同一类变更、该合并" */
  keys: string[]
}

export interface DraftHistory<T> {
  /** 已发生的版本，末尾是当前状态 */
  past: HistoryEntry<T>[]
  /** 被撤销掉、还能重做回来的版本 */
  future: HistoryEntry<T>[]
}

const MAX_DEPTH = 60
/** 合并窗口：拖滑杆是每 16ms 一次，用户不可能想撤销其中任意一次 */
const COALESCE_MS = 600

export function createHistory<T>(state: T): DraftHistory<T> {
  return { past: [{ state, at: Date.now(), keys: [] }], future: [] }
}

export function currentOf<T>(history: DraftHistory<T>): T | null {
  return history.past[history.past.length - 1]?.state ?? null
}

/** 记一笔新状态。`keys` 相同且在合并窗口内 → 替换顶部而不是压栈。 */
export function pushState<T>(
  history: DraftHistory<T>,
  state: T,
  keys: string[],
  at = Date.now(),
): DraftHistory<T> {
  const top = history.past[history.past.length - 1];
  const coalesce =
    top !== undefined &&
    at - top.at < COALESCE_MS &&
    top.keys.length > 0 &&
    top.keys.length === keys.length &&
    top.keys.every((k) => keys.includes(k));
  const entry: HistoryEntry<T> = { state, at, keys };
  const past = coalesce
    ? [...history.past.slice(0, -1), entry]
    : [...history.past, entry];
  return { past: past.slice(-MAX_DEPTH), future: [] };
}

/** 撤销：返回上一版；已经到底就返回 null（**不给一个不动的撤销按钮假装能用**）。 */
export function undo<T>(history: DraftHistory<T>): DraftHistory<T> {
  if (history.past.length < 2) return history;
  const top = history.past[history.past.length - 1];
  const past = history.past.slice(0, -1);
  return { past, future: [top, ...history.future] };
}

/** 重做。 */
export function redo<T>(history: DraftHistory<T>): DraftHistory<T> {
  if (history.future.length === 0) return history;
  const [next, ...rest] = history.future;
  return { past: [...history.past, next], future: rest };
}

export function canUndo<T>(history: DraftHistory<T>): boolean {
  return history.past.length > 1;
}

export function canRedo<T>(history: DraftHistory<T>): boolean {
  return history.future.length > 0
}
