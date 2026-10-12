/** 条目枚举 → i18n key（v0.35）——「状态/类型」文案的唯一作者。
 *
 * 存在理由：仓库里 10 处直接渲染 `{item.status}` / `{item.item_type}`，
 * 于是中文界面里混着 `downloaded`、`video_raw` 这类英文枚举值——用户实测
 * 「中文环境有英文」。词条本身其实早就有了（`console.downloaded` = 已下载、
 * `console.typeVideo` = 视频），缺的只是**取词的那一步**；各处自己拼 key 会
 * 重新漂移，所以收在这里。
 *
 * 与 `PIPELINE_ITEM_TONE` / `ITEM_TYPE_BADGE` 是同一套思路：那几个管
 * 颜色，这两个管文案。调用处用 `useTranslation()` 拿 `t` 传进来。
 */

/** 条目状态（对齐后端 `models/item.ItemStatus`）。 */
const STATUS_KEYS: Record<string, string> = {
  discovered: 'console.discovered',
  scored: 'console.scored',
  downloaded: 'console.downloaded',
  queued: 'console.queued',
  approved: 'console.approved',
  published: 'console.published',
  rejected: 'console.rejected',
  failed: 'console.failed',
}

/** 素材类型（对齐后端 `models/item.ItemType`）。 */
const TYPE_KEYS: Record<string, string> = {
  video_raw: 'console.typeVideo',
  image_gallery: 'console.typeImage',
  text_only: 'console.typeText',
}

/**
 * 状态 → i18n key。未知状态回落到 `console.unknownStatus`（而不是把英文原样
 * 吐出去——那正是这次要消灭的东西）。
 */
export function itemStatusKey(status: string | null | undefined): string {
  return (status && STATUS_KEYS[status]) || 'console.unknownStatus'
}

/** 素材类型 → i18n key；未知类型同样不吐英文。 */
export function itemTypeKey(itemType: string | null | undefined): string {
  return (itemType && TYPE_KEYS[itemType]) || 'console.unknownType'
}

/** 判断某个状态是否有专属词条（给「原样显示」的场景一个显式出口）。 */
export function hasStatusLabel(status: string | null | undefined): boolean {
  return !!status && status in STATUS_KEYS
}
