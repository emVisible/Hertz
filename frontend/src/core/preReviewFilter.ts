/** 未评分区三条筛选轴的请求映射（v0.34 A）——「主题轴 + 质量轴 + 正文有无轴」叠加。
 *
 * 存在理由：这里是**界面选择 → HTTP query** 的唯一构造点。`pipelineApi.items()` 与
 * `pipelineApi.itemFacets()` 都走它，所以「列表筛的是什么」和「分面数的是什么」不会
 * 各拼一套（那一套一旦漂移，界面就变成「命中数说东、列表说西」）。
 *
 * 为什么必须服务端筛：`usePipelineData` 拉 discovered 的 limit 是 500，而活口实测
 * 2659 条——客户端筛只能看见最新 500 条，情感内容一旦不在这 500 条里，界面就会
 * 得出「没有情感内容」的假结论。分母见 docs/ROADMAP.md 与 task-A 简报。
 *
 * 'all' 一律**不发送**该参数：缺省语义 = 后端不加这条条件 = 全部。
 * 默认值必须是「全部」而不是默认情感，否则用户第一次打开会以为数据变少了。
 */

export type PreTheme = 'all' | 'sentiment'
/** 三档阈值 + `unfilled`（分数没采到）——缺值单列，见 quality.QUALITY_UNFILLED：
 *  未评分活口里 17.2% 两个字段一起是 0，那是采集没拿到，不是「质量不行」。 */
export type PreQuality = 'all' | 'loose' | 'standard' | 'strict' | 'unfilled'
export type PreHasText = 'all' | 'yes' | 'no'

export interface PreReviewFilters {
  theme: PreTheme
  quality: PreQuality
  hasText: PreHasText
}

/** 默认 = 三轴全「全部」（不是默认情感）。 */
export const DEFAULT_PRE_FILTERS: PreReviewFilters = {
  theme: 'all',
  quality: 'all',
  hasText: 'all',
}

/** 轴 → query 参数：未选的不发，选了的用后端认得的参数名。 */
export function preReviewQuery(filters: PreReviewFilters): Record<string, string> {
  const query: Record<string, string> = {}
  if (filters.theme !== 'all') query.theme = filters.theme
  if (filters.quality !== 'all') query.quality = filters.quality
  if (filters.hasText !== 'all') query.has_text = filters.hasText === 'yes' ? 'true' : 'false'
  return query
}

function toSearch(params: Record<string, string>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) search.set(key, value)
  return search.toString()
}

/** 列表请求的完整 query：status + limit + 三轴。 */
export function itemsQuery(
  status: string | undefined,
  limit: number,
  filters: PreReviewFilters,
): string {
  return toSearch({
    ...(status ? { status } : {}),
    limit: String(limit),
    ...preReviewQuery(filters),
  })
}

/** 分面请求的完整 query：**不带 limit**——facets 数的是全量分母，不是当前一屏。 */
export function facetsQuery(status: string | undefined, filters: PreReviewFilters): string {
  return toSearch({
    ...(status ? { status } : {}),
    ...preReviewQuery(filters),
  })
}
