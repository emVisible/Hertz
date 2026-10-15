/**
 * 本地草稿快照的判据（W2 自动保存加固）。
 *
 * 动机是一次用户才会遇到、但**丢了就再也回不来**的场景：
 * 自动保存是 800ms debounce 的 PUT，它会失败——后端没起、网络断了、磁盘满。
 * 失败时界面只弹一个 toast，然后 `setSaveState('dirty')`——**内容只活在内存里**。
 * 用户此时切走、关窗口、重启进程，刚写的那一段就没了。
 *
 * 这一层做的事：**每次改动立刻往 localStorage 写一份小快照**，落库成功才清。
 * 于是「关掉程序再打开」能捞回来，「后端没起时写的」也能捞回来。
 *
 * 判据盯三件：
 * ①改动后快照立刻在（不等 800ms）；
 * ②落库成功后快照被清（不然 localStorage 会变成第二真相源）；
 * ③**认得时间戳**：捞回来时必须能判断"本地这份比库里新还是旧"——
 *    盲目拿旧的覆盖新的是最糟的一种数据丢失。
 */
import { describe, expect, it } from 'vitest'

import { clearLocalDraft, peekLocalDraft, readLocalDraft, writeLocalDraft } from './localDraft'


function makeDraft(patch: Partial<{ source_md: string; theme_id: string }> = {}) {
  return {
    title: '稿',
    source_md: '# 标题',
    platform: 'wechat' as const,
    theme_id: 'modi',
    overrides: {},
    footer: '',
    qr: null,
    breaks: [],
    ratio: '3:4' as const,
    coverSub: '',
    coverBadge: '',
    pageNum: true,
    header: '',
    texture: '',
    deco: '',
    platformOverrides: {},
    platformThemes: {},
    ...patch,
  }
}

describe('改动后立刻留一份本地快照', () => {
  it('写进去能原样读回来', () => {
    writeLocalDraft('l1', makeDraft(), '2026-10-15T03:00:00Z')
    const snap = readLocalDraft('l1')
    // 整份 draft 原样存取：只存 source_md 是不够的——主题、封面、比例同样是"内容"
    expect((snap?.draft as { source_md: string }).source_md).toBe('# 标题')
    expect(snap?.serverUpdatedAt).toBe('2026-10-15T03:00:00Z')
  })

  it('不同稿子各存各的（不会串）', () => {
    writeLocalDraft('l1', makeDraft({ source_md: '甲' }), null)
    writeLocalDraft('l2', makeDraft({ source_md: '乙' }), null)
    const text = (id: string) => (readLocalDraft(id)?.draft as { source_md: string }).source_md
    expect(text('l1')).toBe('甲')
    expect(text('l2')).toBe('乙')
  })
})

describe('落库成功后清掉本地快照', () => {
  it('清完就读不到了（否则 localStorage 会变成第二真相源）', () => {
    writeLocalDraft('l1', makeDraft(), null)
    clearLocalDraft('l1')
    expect(readLocalDraft('l1')).toBeNull()
  })
})

describe('判断本地这份是不是更新', () => {
  it('本地比库里新 → newer（该提示恢复）', () => {
    // 本地快照写于 03:00，库里那份是 02:00
    writeLocalDraftAt('l1', makeDraft(), '2026-10-15T03:00:00Z')
    expect(peekLocalDraft('l1', '2026-10-15T02:00:00Z').state).toBe('newer')
  })

  it('库里更新（别处改过）→ stale（不能覆盖，要提示）', () => {
    // 库里 04:00 比本地 03:00 新
    writeLocalDraftAt('l1', makeDraft(), '2026-10-15T03:00:00Z')
    expect(peekLocalDraft('l1', '2026-10-15T04:00:00Z').state).toBe('stale')
  })

  it('时间相同 → same（没有可恢复的东西，别去打扰用户）', () => {
    writeLocalDraftAt('l1', makeDraft(), '2026-10-15T03:00:00Z')
    expect(peekLocalDraft('l1', '2026-10-15T03:00:00Z').state).toBe('same')
  })

  it('没有本地快照 → none', () => {
    expect(peekLocalDraft('nope', '2026-10-15T00:00:00Z').state).toBe('none')
  })
})

describe('坏了的快照不许把应用搞崩', () => {
  it('存储里是垃圾 JSON → 读成 null，而不是抛异常', () => {
    localStorage.setItem('hertz:mdstudio:draft:l1', '{这不是 JSON')
    expect(readLocalDraft('l1')).toBeNull()
  })

  it('存储不可用（隐私模式/配额满）→ 静默降级，不阻断编辑', () => {
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = () => {
      throw new Error('QuotaExceededError')
    }
    try {
      expect(() => writeLocalDraft('l1', makeDraft(), null)).not.toThrow()
    } finally {
      Storage.prototype.setItem = original
    }
  })
})

/**
 * 写一个**指定写入时刻**的快照。
 *
 * 为什么要指定：三态判定（newer/stale/same）全靠时间戳，而生产里 `updatedAt` 是
 * `Date.now()`。不注入就得靠 sleep 等时间流过，那会让判据又慢又不稳。
 */
function writeLocalDraftAt(id: string, draft: unknown, at: string, serverAt: string | null = null) {
  writeLocalDraft(id, draft, serverAt)
  const key = `hertz:mdstudio:draft:${id}`
  const parsed = JSON.parse(localStorage.getItem(key) ?? '{}')
  parsed.updatedAt = new Date(at).getTime()
  localStorage.setItem(key, JSON.stringify(parsed))
}

export {}