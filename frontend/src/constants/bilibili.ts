/** B站分区（tid）常量——单一真相源（AXIOM §1.2）。
 *  官方现行一级分区（对照 bilibili-API-collect「视频分区一览」与
 *  biliup archive/pre typelist），旧版混入的二级分区/废弃 tid 已清理，
 *  保证 tid 与名称均唯一。审核卡「分区」下拉使用，禁止内联数字。 */

export interface BiliTid {
  tid: number
  /** 分区名（zh，B站官方名） */
  name: string
  /** 英文名（下拉展示用，缺省回退 name） */
  en?: string
}

export const BILI_TIDS: BiliTid[] = [
  { tid: 1, name: '动画', en: 'Anime' },
  { tid: 3, name: '音乐', en: 'Music' },
  { tid: 4, name: '游戏', en: 'Game' },
  { tid: 5, name: '娱乐', en: 'Entertainment' },
  { tid: 11, name: '电视剧', en: 'TV Series' },
  { tid: 13, name: '番剧', en: 'Bangumi' },
  { tid: 23, name: '电影', en: 'Movie' },
  { tid: 36, name: '知识', en: 'Knowledge' },
  { tid: 119, name: '鬼畜', en: 'Kichiku' },
  { tid: 129, name: '舞蹈', en: 'Dance' },
  { tid: 155, name: '时尚', en: 'Fashion' },
  { tid: 160, name: '生活', en: 'Life' },
  { tid: 167, name: '国创', en: 'Chinese Animation' },
  { tid: 177, name: '纪录片', en: 'Documentary' },
  { tid: 181, name: '影视', en: 'Film & TV' },
  { tid: 188, name: '科技', en: 'Tech' },
  { tid: 202, name: '资讯', en: 'Information' },
  { tid: 211, name: '美食', en: 'Food' },
  { tid: 217, name: '动物圈', en: 'Animal' },
  { tid: 223, name: '汽车', en: 'Auto' },
  { tid: 234, name: '运动', en: 'Sports' },
]

/** tid → 分区名（含未知兜底） */
export function biliTidName(tid: number | null | undefined, lang: 'zh' | 'en' = 'zh'): string {
  if (!tid) return ''
  const hit = BILI_TIDS.find((p) => p.tid === tid)
  if (!hit) return String(tid)
  return lang === 'en' && hit.en ? hit.en : hit.name
}
