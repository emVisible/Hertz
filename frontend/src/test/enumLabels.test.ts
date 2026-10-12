/** 界面不得直出**条目**枚举（v0.35）——一道 grep 级门禁。
 *
 * 背景：用户报「中文环境有英文」。根因不是缺翻译（8 个状态 + 3 个类型的词条
 * 一直都在），而是 10 处直接渲染 `{item.status}` / `{item.item_type}`——
 * 词条在 i18n 文件里躺着，界面却绕过它去显示英文枚举。
 *
 * 为什么需要这条测试：把 10 处改成 `t(itemStatusKey(...))` 是一次性修复，
 * 而**下一个人加第 11 处**是极可能的。所以要把规则钉成门禁。
 *
 * ## 为什么必须收窄到「条目」枚举
 *
 * 初版只匹配 `{任意标识符.status}`，结果把 13 处**合规**代码全报红了：
 * - `t(\`download.status.${task.status}\`)` / `t(\`settings.healthStatus.…\`)`
 *   —— 已经过 i18n，只是值插在模板里；
 * - `job.status` / `run.status` / `resp.status` —— 运行态与 HTTP 响应，
 *   压根不是条目枚举；
 * - Monoline 作业状态 —— 自有 `STATUS_TONE` 与词条体系。
 *
 * 把它们一并禁掉等于让守卫变成噪音，迟早有人加豁免名单绕过它。所以这里只抓
 * **流水线条目**这一个对象上的 `status` / `item_type` 直出——
 * `{item.*}` / `{i.*}` / `{row.*}` / `{s.*}` / `{r.*}` / `{it.*}`。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(__dirname, '..')

/**
 * 流水线条目在 JSX 里的局部名。
 *
 * 刻意**不含** `s` / `r` / `task`：实测它们在别处是 fetch Response
 * （`r.status`）、Monoline 阶段（`{s.status}`）、下载任务
 * （`task.status`）——各有各的体系，混进名单等于让守卫变成噪音。
 * 宁可名单短，也不要一份「需要豁免名单」的守卫：那种守卫迟早被绕过。
 */
const ITEM_VARS = ['item', 'it', 'rowItem', 'row', 'i', 'clip', 'src']
const ITEM_ENUM = new RegExp(
  `\\{\\s*(?:${ITEM_VARS.join('|')})\\.(?:status|item_type)\\s*\\}`,
  'g',
)

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) tsxFiles(full, out)
    else if (entry.endsWith('.tsx') && !entry.endsWith('.test.tsx')) out.push(full)
  }
  return out
}

describe('条目枚举文案门禁', () => {
  it('没有任何 .tsx 直出条目 status / item_type', () => {
    const offenders: string[] = []
    for (const file of tsxFiles(SRC)) {
      if (file.endsWith(join('core', 'itemLabels.ts'))) continue
      readFileSync(file, 'utf-8')
        .split('\n')
        .forEach((line, i) => {
          // `t(itemStatusKey(item.status))` 这类「枚举当参数」是允许的：
          // 洗掉所有 Key()/Label() 调用，参数位就跟着一起没了。
          const scrubbed = line.replace(/\w*(?:Key|Label)\([^)]*\)/g, 'X()')
          if (scrubbed.match(ITEM_ENUM)) {
            offenders.push(
              `${file.replace(SRC, 'src')}:${i + 1}  ${line.trim().slice(0, 80)}`,
            )
          }
        })
    }
    expect(
      offenders,
      `这些地方直出了英文枚举（中文界面会出现 downloaded/video_raw 之类）：\n${
        offenders.join('\n')
      }\n改法：t(itemStatusKey(x.status)) / t(itemTypeKey(x.item_type))`,
    ).toEqual([])
  })

  it('不误伤已经过 i18n 的写法', () => {
    // 模板 key 也是合法写法：值插在 i18n key 里，界面输出的是词条。
    expect('{t(`download.status.${task.status}`)}'.match(ITEM_ENUM)).toBeNull()
    expect('{t(itemStatusKey(item.status))}'.replace(/\w*(?:Key|Label)\([^)]*\)/g, 'X()')
      .match(ITEM_ENUM)).toBeNull()
  })

  it('不误伤别的域的 .status', () => {
    // 运行态 / HTTP / Monoline 作业 / 下载任务的状态都不是条目枚举——
    // 这几类都真实存在于本仓（ActivityPanel、fetch、monoline/JobsTab、assets），
    // 守卫误报它们的话，加豁免名单只是时间问题。
    for (const ok of [
      '{job.status}', '{run.status}', '{resp.status}',
      '{task.status}', '{s.status}', '{r.status}',
    ]) {
      expect(ok.match(ITEM_ENUM), ok).toBeNull()
    }
  })
})
