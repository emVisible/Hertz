/** i18n 目录守卫（v0.34 B）：中英两份键集必须相等，退役键不许留下。
 *
 * 为什么现在补这一条：本仓**从来没有**校验过 i18n（已核：`tests/*.py` 与前端测试里
 * 对 `zh.json` / `en.json` 的引用是零命中）。结果是漂移靠人肉发现——实测就有
 * `common.copyTitle` 只在中文、`common.custom` 只在英文，切到另一种语言时界面直接
 * 露出键名。撤掉日历/队列视图时删的键更多，没有守卫就一定会漏一半（留下一半孤儿键，
 * 或者删多了一半还在用的键）。
 *
 * 判据只有两条，都是可判的：
 * ①两份目录的叶子键集**相等**（谁都不许多）；
 * ②这一片退役掉的键（日历 / 队列视图 / 入队）在两份目录里都不存在，
 *   而且不再被任何 `.ts` / `.tsx` 引用。
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
    else if (/\.(ts|tsx)$/.test(entry) && !full.endsWith('catalog.test.ts')) {
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
    expect(usedAsKey('console.backToReview'), '判据抓不到 BoardTab 的直用键=判据是坏的').toBe(true)
    // 已知盲区（如实写下，不假装这条守卫是全量的）：两种「间接用键」都抓不到——
    // ①拼出来的：`t(\`console.busy.${action}\`)`；②存在映射表里的：
    // `{ key: 'approved', labelKey: 'console.stagePublish' }`（DashboardPage 就是这么用的）。
    // 所以本条只负责「删掉的视图不许还有人直读」。新界面的键由下一条测试兜住
    // （它按 BoardTab 源码里的 `console.board*` 文本名单去目录里查，映射表写法也能命中）。
    // 全量孤儿检查是另一片的工作。
  })

  it('看板用到的键在两份目录里都存在', () => {
    // 正向腿：上面几条只证明「删干净了」，这一条证明**新界面要的键真的在**。
    // 缺键的形状是界面渲染出 `console.boardColFocus` 这种裸键名，而它不会报错。
    const zh = new Set(leafKeys(catalog('zh')))
    const en = new Set(leafKeys(catalog('en')))
    const needed = [
      'console.boardProgress',
      'console.boardGoalSave',
      'console.boardColFocus',
      'console.boardColInWork',
      'console.boardColReview',
      'console.boardColReady',
      'console.boardColPublished',
      'console.boardPickToday',
      'console.boardRemoveToday',
      'console.boardNotePlaceholder',
      'console.boardEmptyFocus',
      'console.boardGoPreReview',
      'console.boardTruncated',
    ]
    const missingZh = needed.filter((k) => !zh.has(k))
    const missingEn = needed.filter((k) => !en.has(k))
    expect(missingZh, `中文缺：${missingZh.join(', ')}`).toEqual([])
    expect(missingEn, `英文缺：${missingEn.join(', ')}`).toEqual([])
    // 引用面核对：BoardTab 里出现的 board* 键必须都在目录里（防「界面写了新键、
    // 目录没加」——那正是这条守卫要防的形状，而不是只测我手抄的这份名单）
    const boardTab = readFileSync(join(SRC, 'pages', 'dashboard', 'BoardTab.tsx'), 'utf-8')
    const used = [...boardTab.matchAll(/console\.board[A-Za-z0-9]*/g)].map((m) => m[0])
    expect(used.length, 'BoardTab 里一个 board* 键都没找到=正则或文件路径错了') .toBeGreaterThan(10)
    const absent = [...new Set(used)].filter((k) => !zh.has(k))
    expect(absent, `BoardTab 引用了目录里没有的键：${absent.join(', ')}`).toEqual([])
  })
})
