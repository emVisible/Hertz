/** 采集源池目录（v0.11.6 情感频道）：设置页「源池勾选」的单一真相源。
 *  勾选状态 = pipeline_sources（逗号分隔字符串）；自定义源走独立输入框。
 *  group.labelKey → i18n（settings.sourceGroup*）。 */

export interface SourceGroup {
  id: string
  labelKey: string
  sources: string[]
}

export const SOURCE_GROUPS: SourceGroup[] = [
  {
    id: 'emotion',
    labelKey: 'settings.sourceGroupEmotion',
    sources: [
      'MadeMeSmile',
      'MadeMeCry',
      'HumansBeingBros',
      'wholesome',
      'ContagiousLaughter',
      'WatchPeopleDieInside',
      'TikTokCringe',
      'Unexpected',
    ],
  },
  {
    id: 'story',
    labelKey: 'settings.sourceGroupStory',
    sources: [
      'AmItheAsshole',
      'TrueOffMyChest',
      'offmychest',
      'relationship_advice',
      'relationships',
      'JustNoFamily',
      'BestofRedditorUpdates',
    ],
  },
  {
    id: 'legacy',
    labelKey: 'settings.sourceGroupLegacy',
    sources: [
      'Damnthatsinteresting',
      'BeAmazed',
      'nextfuckinglevel',
      'interestingasfuck',
      'ThatsInsane',
      'Whatcouldgowrong',
      'PerfectTiming',
      'oddlysatisfying',
    ],
  },
]

export const SOURCE_CATALOG_NAMES: Set<string> = new Set(
  SOURCE_GROUPS.flatMap((g) => g.sources),
)
