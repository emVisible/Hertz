/** 敏感词扫描器前线（v0.37 P0-1）——由「知命工作室」主编按本号红线维护。

## 两层结构：通用 5 类 + 命理专属

通用 5 类（暴恐 / 色情低俗 / 政治敏感 / 低俗辱骂 / 低质灌水）对齐各平台合规体系
（壹伴 5 类违规口径，18 种隐蔽风险第一版子集）——这里只放**能被词频定位**的词，
摘要词（如"色情""政治"）不放，靠规则补。

命理专属：本号「讲命理不算命」路线下，失守的不是词频而是**话术**——把一套本来
作为文化话题的词，用作功效宣称、占卜服务、灵修咒语的动词。名单里尽量给「可议论、
不能官宣」的结构，而不是「可以写作但不能官宣」的词（那种交给白名单与人工审校
才是正路，空气太细，机器改错代价太大）。

## 记录格式

每个条目: { category, term, aliases? }
- alias: 首个字符取拼音首字母（"改运"←"gy"），大小写不敏感；本号章法不常用，只
  放已有第一手案例。拆字解词（"改"拆作"己+攵"）本版本**不做**——太脆，第一版
  放手把间隔符/别名收住。
- term / alias 中间可夹分隔符（空格、·、*、-、_、~），匹配时不敏感——
  「改 运」「改·运」「改*运」三种逃逸写法统一命中。

## 维护

- 新增条目直接在本文件追加（会被扫描器取到），或发给主编审核合并。
- 不要在这里放：章法词（命、命运、轮回、五行……）——它们是文化话题，百万字里
  只会碰到一两次，不值得一条命中判断的成本；写在稿里时用白名单，读本时按分区。

## 判据

成对变异：删掉本文件装载的词表 → 所有命中断言全红；补回 → 绿。
*/

import type { ComplianceCategory } from './types'

/** 词表条目：term + 可选的误写别名。 */
export interface ComplianceWord {
  term: string
  aliases?: string[]
}

export interface ComplianceWordlist {
  category: ComplianceCategory
  name: string
  terms: (string | ComplianceWord)[]
}

/** 通用 5 类词表（词频定位，摘要词例外描述见模块注释）。 */
export const GENERAL_LISTS: ComplianceWordlist[] = [
  {
    category: 'violence',
    name: '暴恐',
    terms: ['匕首', '炸弹', '毒气', '核弹', 'S 蛋', '爆炸', '凶手'],
  },
  {
    category: 'sexual',
    name: '色情低俗',
    terms: ['黄色', '性行为', '夜店', '低俗', '情色', '诱惑', '私处'],
  },
  {
    category: 'political',
    name: '政治敏感',
    terms: ['台独', '藏独', '疆独', '分裂国家', '颠覆政权', '煽动颠覆', '保护色'],
  },
  {
    category: 'abuse',
    name: '低俗辱骂',
    terms: ['傻逼', '混蛋', '废物', '弱智', '懒虫', '娘', '操你', '妈的'],
  },
  {
    category: 'spam',
    name: '低质灌水',
    terms: ['网赚', '静态', '福报', '血汗钱', '收藏', '一键', '封神'],
  },
]

/** 命理专属词表（话术层，不是话题层）。维护者按本号红线增删。 */
export const METAPHYSICS_LIST: ComplianceWordlist = {
  category: 'metaphysics',
  name: '命理话术',
  terms: [
    // 改运/转运/消灾
    { term: '改运', aliases: ['gy'] },
    { term: '转运', aliases: ['zz'] },
    { term: '消灾', aliases: ['xc'] },
    { term: '破灾', aliases: ['pc'] },
    { term: '避灾', aliases: ['bc'] },
    { term: '化灾', aliases: ['hc'] },
    { term: '驱灾', aliases: ['jc'] },
    { term: '转危为安', aliases: ['zwy'] },
    // 灵修/玄机
    { term: '通灵', aliases: ['tl'] },
    { term: '通天', aliases: ['tt'] },
    { term: '玄机', aliases: ['xz'] },
    { term: '看得见', aliases: ['kdj'] },
    { term: '看透', aliases: ['kt'] },
    { term: '看出', aliases: ['kc'] },
    { term: '天机', aliases: ['tj'] },
    // 符咒/法术
    { term: '符咒', aliases: ['fzh'] },
    { term: '咒语', aliases: ['zyth'] },
    { term: '诵咒', aliases: ['szch'] },
    { term: '施法', aliases: ['sf'] },
    { term: '作法', aliases: ['zfa'] },
    { term: '驱鬼', aliases: ['qgh'] },
    { term: '捉鬼', aliases: ['zgh'] },
    { term: '降头', aliases: ['jh'] },
    { term: '开光', aliases: ['kl'] },
    { term: '封魔', aliases: ['fm'] },
    { term: '镇宅', aliases: ['zz'] },
    { term: '招财', aliases: ['cc'] },
    { term: '聚财', aliases: ['jc'] },
    // 占卜/断言
    { term: '看命', aliases: ['km'] },
    { term: '测字', aliases: ['cz'] },
    { term: '起名', aliases: ['qn'] },
    { term: '灵验', aliases: ['lvy'] },
    { term: '应验', aliases: ['yy'] },
    { term: '有效', aliases: ['yy'] },
    { term: '必定', aliases: ['bd'] },
    { term: '百分之百', aliases: ['bppb'] },
    { term: '无疑', aliases: ['wy'] },
    { term: '一定会', aliases: ['yzh'] },
    { term: '保证', aliases: ['bz'] },
    { term: '立竿', aliases: ['jgl'] },
    // 发起者
    { term: '神婆', aliases: ['sby'] },
    { term: '道士', aliases: ['ds'] },
    { term: '大仙', aliases: ['dx'] },
    { term: '仙家', aliases: ['xj'] },
    { term: '修行', aliases: ['xhx'] },
    { term: '养生', aliases: ['ys'] },
  ],
}

/** 扫描时沿用内置表。新的词表可以接在这里。 */
export const BUILT_IN: ComplianceWordlist[] = [...GENERAL_LISTS, METAPHYSICS_LIST]
