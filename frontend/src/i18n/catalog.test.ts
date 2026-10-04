/** i18n 目录守卫（v0.34 B）：中英两份键集必须相等，退役键不许留下。
 *
 * 为什么现在补这一条：本仓**从来没有**校验过 i18n（已核：`tests/*.py` 与前端测试里
 * 对 `zh.json` / `en.json` 的引用是零命中）。结果是漂移靠人肉发现——实测就有
 * `common.copyTitle` 只在中文、`common.custom` 只在英文，切到另一种语言时界面直接
 * 露出键名。撤掉日历/队列视图时删的键更多，没有守卫就一定会漏一半（留下一半孤儿键，
 * 或者删多了一半还在用的键）。
 *
 * 判据只有三条，都是可判的：
 * ①两份目录的叶子键集**相等**（谁都不许多），且每个叶子值都是字符串；
 * ②这一片退役掉的键（日历 / 队列视图 / 入队 / 看板里的目标编辑）在两份目录里都不存在，
 *   而且不再被任何 `.ts` / `.tsx` 引用；
 * ③新界面（看板三栏目 + 设置「每日目标」）要的键确实存在于两份目录。
 * 不做「每个键都必须被引用」那种全量孤儿检查——动态键（`console.busy.${action}`、
 * `queue.phase.${phase}` 这类拼出来的）会把它喂出一堆假阳性，那是另一片的工作。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

// jsdom 下 `import.meta.url` 不是 file: 协议（`fileURLToPath` 会直接抛），所以根目录
// 从 cwd 取——vitest 的工作目录就是 `frontend/`。目录不存在时必须响亮失败，
// 而不是让后面每个断言都「恰好通过」（读不到文件=键集为空=两条集合相等成立）。
const SRC = resolve(process.cwd(), 'src')

function assertRoot() {
  if (!existsSync(join(SRC, 'i18n', 'zh.json'))) {
    throw new Error(`i18n 目录不在预期位置：${SRC}（vitest 的 cwd 必须是 frontend/）`)
  }
}

function catalog(lang: 'zh' | 'en'): Record<string, unknown> {
  const path = join(SRC, 'i18n', `${lang}.json`)
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
}

function leafKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = []
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out.push(...leafKeys(value as Record<string, unknown>, path))
    } else {
      out.push(path)
    }
  }
  return out.sort()
}

function sourceFiles(dir: string = SRC): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    // 测试文件不算「在用」：守卫管的是界面代码。反向的用法本身就发生在测试里——
    // `tabs.test.ts` 为了断言「看板不再引用 dashboard.sectionSupply」必须写出那个键名，
    // 把它算成使用会让退役清单永远关不上（负向文本守卫被自己的断言喂饱）。
    else if (/\.tsx?$/.test(entry) && !entry.endsWith('.test.ts') && !entry.endsWith('.test.tsx')) {
      out.push(full)
    }
  }
  return out
}

const RETIRED = [
  'console.calendar',
  'console.calendarList',
  'console.calendarToday',
  'console.calendarPrev',
  'console.calendarNext',
  'console.calendarPublished',
  'console.calendarUnscheduled',
  'console.calendarDropHint',
  'console.calendarDropClear',
  'console.calendarNoUnscheduled',
  'console.calendarWeek',
  'console.calendarBatchSelected',
  'console.calendarBatchHint',
  'console.calendarBatchClear',
  'console.calendarBatchScheduled',
  'console.queueView',
  'console.queueLabel',
  'console.queueToHolding',
  'console.queueToReady',
  'console.queueLeave',
  'console.queueLeaveReady',
  'console.queueHoldingOk',
  'console.queueReadyOk',
  'console.queueLeaveOk',
  'queue',
  // v0.34 看板重设计（D-217）：目标编辑从看板搬去「设置 → 每日目标」，
  // 看板只显示所以这些编辑用键退役（同义文案在 `settings.goal*` 下重开）。
  'console.boardGoalLabel',
  'console.boardGoalPlaceholder',
  'console.boardGoalSave',
  'console.boardGoalSaving',
  'console.boardGoalSaved',
  'console.boardGoalSaveFailed',
  'console.boardGoalLimit',
  // 「在制」不再单列一栏（捞进今天的才进「今天」，其余留在流水线）
  'console.boardColInWork',
  // 三个栏目 tab 取代了那条「运营面板」分区标题；漏斗/用量/成本的旧单卡标题并进了合卡标题
  'dashboard.monitorTitle',
  'dashboard.funnel',
  'dashboard.usage',
  'dashboard.cost',
  // v0.34 D-218：供给从独立栏目并进「今天」；看板的「待处理」两列搬去流水线，
  // 那两列用的空态/截断/批处理提示文案跟着退役（待发分段另起了 `console.approved*`）
  'dashboard.awaiting',
  'dashboard.sectionSupply',
  'console.boardColumnEmpty',
  'console.boardTruncated',
  'console.boardColReady',
  'console.publishHint',
  // v0.34 D-219：今日待办收成右侧悬浮栏，只留目标清单与一个最简指标——
  // 条目列表（含空态动线）、今日已发那排 chip、加工备注输入框都从看板上撤了
  // （条目动作与补录数据在流水线；`focus_note` 字段与端点仍在，界面上暂时没有了写点，实测 0/5281 用过）
  'console.boardProgress',
  'console.boardColPublished',
  'console.boardEmptyFocus',
  'console.boardGoPreReview',
  'console.boardRemoveToday',
  'console.boardDropHint',
  'console.boardNoteLabel',
  'console.boardNotePlaceholder',
]

describe('i18n 目录', () => {
  beforeAll(assertRoot)

  it('中文与英文的叶子键集相等', () => {
    const zh = leafKeys(catalog('zh'))
    const en = leafKeys(catalog('en'))
    const zhOnly = zh.filter((k) => !en.includes(k))
    const enOnly = en.filter((k) => !zh.includes(k))
    expect(zhOnly, `只有中文有：${zhOnly.slice(0, 10).join(', ')}`).toEqual([])
    expect(enOnly, `只有英文有：${enOnly.slice(0, 10).join(', ')}`).toEqual([])
    // 键集相等之外还要钉住「两份都不空」——两份都删成 {} 也能通过上面两条
    expect(zh.length).toBeGreaterThan(1000)
  })

  it('两份目录都能解析且顶层命名空间一致', () => {
    expect(Object.keys(catalog('zh')).sort()).toEqual(Object.keys(catalog('en')).sort())
  })

  it('退役视图的键已从两份目录删除', () => {
    const zh = new Set(leafKeys(catalog('zh')))
    const en = new Set(leafKeys(catalog('en')))
    const stillThere = RETIRED.filter(
      (key) => zh.has(key) || en.has(key) || [...zh].some((k) => k.startsWith(`${key}.`)),
    )
    expect(stillThere, `这些键还活着：${stillThere.join(', ')}`).toEqual([])
  })

  it('退役视图的键不再被任何源码引用', () => {
    const files = sourceFiles()
    const blob = files.map((f) => readFileSync(f, 'utf-8')).join('\n')
    // 判据是「被当成翻译键用了」，不是「字符串出现过」：本仓的解释性注释里全是
    // `queue_phase`、`POST /items/{id}/queue` 这样的反引号词，用裸 substring 匹配
    // 会被自己的注释喂饱（负向文本守卫的经典失效形状）。
    const usedAsKey = (key: string) =>
      blob.includes(`('${key}'`) ||
      blob.includes(`('${key}.`) ||
      blob.includes(`(\`${key}`) ||
      blob.includes(`(\`${key}.`)
    const hits = RETIRED.filter(usedAsKey)
    expect(hits, `还有人引用退役键：${hits.join(', ')}`).toEqual([])
    // 对照组：判据必须能抓到**确实在用**的键，否则「零命中」可能只是判据不可达
    // （空结果≠不存在，这条在本仓被坑过两次）。两处都是直写 `t('…')` 形态。
    expect(usedAsKey('common.copyTitle'), '判据抓不到 tCopy(...) 的直用键=判据是坏的').toBe(true)
    expect(usedAsKey('console.backToReviewHint'), '判据抓不到 TodayPanel 的直用键=判据是坏的').toBe(true)
    // 已知盲区（如实写下，不假装这条守卫是全量的）：两种「间接用键」都抓不到——
    // ①拼出来的：`t(\`console.busy.${action}\`)`；②存在映射表里的：
    // `{ key: 'approved', labelKey: 'console.stagePublish' }`（DashboardPage 就是这么用的）。
    // 所以本条只负责「删掉的视图不许还有人直读」。全量孤儿检查是另一片的工作。
  })

  it('看板与设置「每日目标」用到的键在两份目录里都存在', () => {
    // 正向腿：上面几条只证明「删干净了」，这一条证明**新界面要的键真的在**。
    // 缺键的形状是界面渲染出 `console.boardColFocus` 这种裸键名，而它不会报错。
    const zh = new Set(leafKeys(catalog('zh')))
    const en = new Set(leafKeys(catalog('en')))
    const needed = [
      'console.boardGoalSavedAt',
      'console.boardColFocus',
      'console.boardColReview',
      'console.boardPickToday',
      'console.boardPickedToday',
      'console.approvedEmpty',
      'console.approvedHint',
      'console.publishedEmpty',
      'console.published',
      'console.stats',
      'dashboard.sectionToday',
      'dashboard.sectionHealth',
      'dashboard.supplyWater',
      'dashboard.publishHealth',
      'dashboard.usageCost',
      'dashboard.goalEmpty',
      'dashboard.todoDone',
      'dashboard.publishedToday',
      'dashboard.goalCarriedFrom',
      'dashboard.goalCarriedHint',
      'dashboard.goalEditText',
      'settings.navGoal',
      'settings.goalTitle',
      'settings.goalSaveHint',
    ]
    const missingZh = needed.filter((k) => !zh.has(k))
    const missingEn = needed.filter((k) => !en.has(k))
    expect(missingZh, `中文缺：${missingZh.join(', ')}`).toEqual([])
    expect(missingEn, `英文缺：${missingEn.join(', ')}`).toEqual([])
    // 引用面核对：这一片的源码里出现的 `console.board*` / `dashboard.*` / `settings.goal*`
    // 键必须都在目录里（防「界面写了新键、目录没加」——那正是这条守卫要防的形状，
    // 而不是只测我手抄的这份名单）
    const panelFiles = [
      'pages/dashboard/TodayPanel.tsx',
      'pages/dashboard/SupplySection.tsx',
      'pages/dashboard/HealthPanel.tsx',
      'pages/dashboard/DashboardPage.tsx',
      'pages/dashboard/shared.tsx',
      'pages/settings/sections/GoalSection.tsx',
      'components/execution/TodayPick.tsx',
      'pages/execution/pipeline/InReviewTab.tsx',
    ].map((rel) => readFileSync(join(SRC, rel), 'utf-8'))
    const used = panelFiles
      .flatMap((text) => [...text.matchAll(/\b(?:console\.board|console\.approved|dashboard\.|settings\.goal|settings\.navGoal)[A-Za-z0-9]*/g)])
      .map((m) => m[0])
    expect(used.length, '一个看板键都没找到=正则或文件路径错了').toBeGreaterThan(20)
    const absent = [...new Set(used)].filter((k) => !zh.has(k))
    expect(absent, `界面引用了目录里没有的键：${absent.join(', ')}`).toEqual([])
  })

  it('每个叶子值都是字符串（数组/对象会让界面显示 [object Object]）', () => {
    // 这条是被自己坑出来的：批量加键时把 (中文, 英文) 元组原样塞了进去，两份目录
    // 键数一样、键集相等，上面几条全绿，而界面会渲染出 `["…","…"]`。
    for (const lang of ['zh', 'en'] as const) {
      const doc = catalog(lang)
      const bad: string[] = []
      const walk = (o: Record<string, unknown>, prefix = '') => {
        for (const [k, v] of Object.entries(o)) {
          const path = prefix ? `${prefix}.${k}` : k
          if (v && typeof v === 'object') walk(v as Record<string, unknown>, path)
          else if (typeof v !== 'string') bad.push(`${path}=${JSON.stringify(v)}`)
        }
      }
      walk(doc)
      expect(bad, `${lang} 里这些叶子不是字符串：${bad.join(', ')}`).toEqual([])
    }
  })
})
