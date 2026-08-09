/** B站分区（tid）常量——单一真相源（AXIOM §1.2）。
 *  参考原项目 Autarkeia pipeline/category.py 的 BILIBILI_CATEGORIES，
 *  补充当前常用一级分区。审核卡「分区」下拉使用，禁止内联数字。 */

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
  { tid: 21, name: '日常', en: 'Daily' },
  { tid: 36, name: '知识', en: 'Knowledge' },
  { tid: 54, name: '生活', en: 'Life' },
  { tid: 85, name: '科学', en: 'Science' },
  { tid: 95, name: '数码', en: 'Digital' },
  { tid: 138, name: '搞笑', en: 'Funny' },
  { tid: 152, name: '动物', en: 'Animals' },
  { tid: 154, name: '健身', en: 'Fitness' },
  { tid: 155, name: '旅行', en: 'Travel' },
  { tid: 160, name: '生活日常', en: 'Daily life' },
  { tid: 161, name: '生活记录', en: 'Vlog' },
  { tid: 167, name: '影视', en: 'Film & TV' },
  { tid: 179, name: '影视剪辑', en: 'Clip' },
  { tid: 188, name: '科技', en: 'Tech' },
  { tid: 201, name: '知识', en: 'Knowledge' },
  { tid: 211, name: '美食', en: 'Food' },
  { tid: 221, name: '动物圈', en: 'Animal circle' },
  { tid: 223, name: '汽车', en: 'Auto' },
  { tid: 234, name: '运动', en: 'Sports' },
  { tid: 254, name: '搞笑', en: 'Funny' },
  { tid: 250, name: '记录', en: 'Documentary' },
]

/** tid → 分区名（含未知兜底） */
export function biliTidName(tid: number | null | undefined, lang: 'zh' | 'en' = 'zh'): string {
  if (!tid) return ''
  const hit = BILI_TIDS.find((p) => p.tid === tid)
  if (!hit) return String(tid)
  return lang === 'en' && hit.en ? hit.en : hit.name
}
