/** 看板请求参数（v0.34 B）——「界面上的某一天」→「后端的 date + UTC 区间」。
 *
 * 存在理由：这是**界面日期 → HTTP query** 的唯一构造点。看板要的是「用户墙上那天」，
 * 而后端明确不猜时区（spec §4.1：`focus_date` 存墙上日期，`published_at` 存 UTC）。
 * 于是换算只许发生一次：`board()` 与以后任何按天取数的地方都走这里，否则会出现
 * 「今日列按本地日切、发布列按 UTC 日切」这种同一屏两个「今天」的漂移。
 *
 * 区间是**半开**的 `[本地零点, 次日本地零点)`：含两端会把正好落在午夜那一瞬的
 * 发布算进两天，`已发 N` 随之虚高。
 */

/** 每日目标文本长度上限——**镜像**后端 `board_store.GOAL_MAX_CHARS`（判据的作者在那边）。
 *
 * 这里只用来做输入提示与 `maxLength`；真正的拒绝仍由后端 422 发生。镜像会漂，所以
 * `boardWindow.test.ts` 有一条把它和 Python 侧那个数对在一起的守卫（照 `INVALID_POOL_LIMIT`
 * 的先例：界面需要一个数才能画，但判据不许在两边各写一份逻辑）。
 */
export const GOAL_MAX_CHARS = 4000

/** 本地墙上日期 `YYYY-MM-DD`（不是 `toISOString().slice(0,10)`——那个是 UTC 日期，
 *  东八区晚上八点看板上会显示成昨天）。 */
export function wallDay(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 把 `YYYY-MM-DD` 解释成**本地零点**并给出半开区间（UTC ISO，后端会归一化成 +00:00）。 */
export function dayWindow(day: string): { from: string; to: string } {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!parts) throw new Error(`day 必须是 YYYY-MM-DD，收到的是「${day}」`);
  const start = new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
  const end = new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]) + 1);
  return { from: start.toISOString(), to: end.toISOString() };
}

/** 「去看未评分区筛情感素材」这一跳要一次改齐的四件事（v0.34 顶级看板 → 流水线）。
 *
 * 为什么抽成函数而不是在页面里手写字面量：这条动线上过一版就是**半根线**——只设了
 * 两轴、没设分段，用户跳过去落在「已下载未加工」上，那条筛选条根本不渲染，看起来
 * 像「筛不出东西」。四件事（轴 ×2 + 分段 + tab）缺一个就是同一个 bug，所以它们
 * 得是一个值，且可测。
 */
export function goUnscoredPatch(): {
  preTheme: 'sentiment'
  preHasText: 'yes'
  preStage: 'discovered'
  tab: 'preReview'
} {
  return { preTheme: 'sentiment', preHasText: 'yes', preStage: 'discovered', tab: 'preReview' }
}

/** 看板端点的完整 query：`date` 给今日列，`from`/`to` 给发布列。 */
export function boardQuery(day: string): string {
  const { from, to } = dayWindow(day);
  return `date=${encodeURIComponent(day)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
}
