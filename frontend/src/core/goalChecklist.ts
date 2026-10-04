/** 每日目标的「一行一条待办」语义（v0.34 D-218）——解析与勾选状态的唯一作者。
 *
 * 为什么把勾选写进文本本身而不是新加一列：目标已经是「一天一行、一列纯文字」，
 * 再加 `goal_items(JSONB)` 就有两个真相源——他改文字时勾选会指向错行，
 * 而删除某行后那行的完成状态还得靠对账才能清掉。写进文本就没有这个问题：
 * `- [x] 过一遍 AITA 前 20 条` 复制出去仍是一份能读的清单，换一天就是新的一行。
 *
 * 三条不是显然的判断，都有测试钉着：
 * ① **未标记的行也是待办**——他不该为了用勾选而先学会写 `- [ ]`；
 * ② **只改被点的那一行**，其余行与空行原样保留（换行风格也保留：全文 CRLF 就还 CRLF，
 *    否则点一次勾会把整段他写的字重新排一遍）；
 * ③ 取消勾选留 `- [ ] ` 而不是退回原样——那是他动过的行，标记本身就是信息。
 */

export interface GoalLine {
  /** 在原文里的行号（toggle 用它定位，界面不许自己数） */
  index: number
  raw: string
  /** 去掉缩进、项目符号与勾选标记后的正文 */
  content: string
  done: boolean
  /** 空行不是待办，只是排版 */
  blank: boolean
}

/** `- [x] 内容` / `* [ ] 内容`（缩进允许，X 大小写都认） */
const MARKED = /^(\s*)(?:[-*]\s*)?\[( |x|X)\]\s?(.*)$/
/** 普通项目符号行 `- 内容`：勾选时把它升级成带框的那一行，不叠成 `- - [x]`  */
const BULLET = /^(\s*)[-*]\s+(.*)$/

export function parseGoalLines(text: string): GoalLine[] {
  return text.split(/\r?\n/).map((raw, index) => {
    const marked = MARKED.exec(raw)
    if (marked) {
      return {
        index,
        raw,
        content: marked[3].trim(),
        done: marked[2] !== ' ',
        blank: marked[3].trim() === '',
      }
    }
    const bullet = BULLET.exec(raw)
    return {
      index,
      raw,
      content: (bullet ? bullet[2] : raw).trim(),
      done: false,
      blank: raw.trim() === '',
    }
  })
}

/** 翻转第 `index` 行的勾选状态，返回**整段**新文本。
 *  越界或空行一律原样返回——宁可什么都不做，也不猜一行。 */
export function toggleGoalLine(text: string, index: number): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const raw = lines[index]
  if (raw === undefined) return text

  const marked = MARKED.exec(raw)
  const bullet = BULLET.exec(raw)
  const indent = marked?.[1] ?? bullet?.[1] ?? /^(\s*)/.exec(raw)?.[1] ?? ''
  const content = (marked?.[3] ?? bullet?.[2] ?? raw.slice(indent.length)).trim()
  if (!content) return text

  const done = marked ? marked[2] !== ' ' : false
  lines[index] = `${indent}- [${done ? ' ' : 'x'}] ${content}`
  return lines.join(eol)
}

/** 把每一项勾掉（v0.34 D-220）。
 *
 * 沿用昨天的清单到今天时，昨天的勾**不算今天的完成**——这份清单是每天重复的例行事项。
 * 洗勾只发生在界面读到 `carried_from` 非空的那一刻：后端只回答"抄哪一份"，
 * 一行怎么算勾着、取消勾长什么样仍然由这一个作者说了算（Python 侧再实现一遍就会漂）。
 * 没带标记的行原样留着，正文与行序一个字都不动。
 */
export function clearGoalTicks(text: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  return text
    .split(/\r?\n/)
    .map((raw) => {
      const m = MARKED.exec(raw)
      if (!m || m[2] === ' ') return raw
      return `${m[1]}- [ ] ${m[3]}`
    })
    .join(eol)
}

/** 「已完成 x / y」——分母只数非空行。 */
export function goalProgress(lines: GoalLine[]): { done: number; total: number } {
  const todos = lines.filter((l) => !l.blank)
  return { done: todos.filter((l) => l.done).length, total: todos.length }
}
