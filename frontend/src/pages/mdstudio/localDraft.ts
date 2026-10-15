/**
 * 本地草稿快照（W2 自动保存加固）。
 *
 * 自动保存是 800ms debounce 的 PUT，它**会失败**：后端没起、网络断了、磁盘满。
 * 失败时界面只弹一个 toast，状态退回 `dirty`——而内容只活在内存里。此时用户切走、
 * 关窗口、重启进程，刚写的那一段**永久消失**。
 *
 * 这一层是那张后悔药：每次改动**立刻**往 localStorage 写一份小快照，落库成功才清。
 * 于是「关掉程序再打开」能捞回来，「后端没起时写的」也能捞回来。
 *
 * 三个设计决定：
 * ①**只存一份、只存当前打开的稿**：localStorage 只有几 MB，全量历史快照会把它塞满，
 *   塞满之后写入静默失败，反而制造"以为存了其实没存"的假象。
 * ②**带时间戳**：捞之前必须能判断"本地这份比库里新还是旧"。盲目拿旧的覆盖新的
 *   是最糟的一种数据损失——**比丢数据更坏**。
 * ③**存储不可用时静默降级**：隐私模式/配额满时写入会抛，但那不该阻断编辑。
 */

const KEY = (id: string) => `hertz:mdstudio:draft:${id}`

export interface LocalDraftSnapshot {
  draft: unknown
  /** 落库那一刻服务端给的 updated_at（没落过就是 null） */
  serverUpdatedAt: string | null
  /** 本地快照写入时刻（ms） */
  updatedAt: number
}

export type PeekResult =
  | { state: 'none' }
  | { state: 'newer'; snapshot: LocalDraftSnapshot }
  | { state: 'stale'; snapshot: LocalDraftSnapshot }
  | { state: 'same'; snapshot: LocalDraftSnapshot }

export function writeLocalDraft(id: string, draft: unknown, serverUpdatedAt: string | null): void {
  try {
    const snapshot: LocalDraftSnapshot = { draft, serverUpdatedAt, updatedAt: Date.now() }
    localStorage.setItem(KEY(id), JSON.stringify(snapshot))
  } catch {
    // 配额满 / 隐私模式：写不进去就算了，**不能因此打断编辑**。
    // 少一层保护不是灾难，崩掉才是。
  }
}

export function readLocalDraft(id: string): LocalDraftSnapshot | null {
  try {
    const raw = localStorage.getItem(KEY(id))
    if (!raw) return null
    const parsed = JSON.parse(raw) as LocalDraftSnapshot
    if (typeof parsed?.updatedAt !== 'number') return null
    return parsed
  } catch {
    // 存储里是垃圾（比如被别的版本写过）→ 当它不存在，而不是把应用搞崩
    return null
  }
}

export function clearLocalDraft(id: string): void {
  try {
    localStorage.removeItem(KEY(id))
  } catch {
    /* 同上：清不掉不是错误 */
  }
}

/**
 * 本地这份能不能用。
 *
 * `serverAt` 是刚取回的库里那份的 updated_at。三态而不是布尔：
 * - `newer`：本地晚于库里 → 该提示恢复（多半是上次没存上）
 * - `stale`：库里晚于本地 → **别覆盖**（多半是你在别处改过），只提示
 * - `same`：一致 → 没有可恢复的东西，别去打扰用户
 */
export function peekLocalDraft(id: string, serverAt?: string | null): PeekResult {
  const snapshot = readLocalDraft(id)
  if (!snapshot) return { state: 'none' }
  if (serverAt) {
    const serverMs = new Date(serverAt).getTime()
    if (Number.isFinite(serverMs)) {
      if (snapshot.updatedAt > serverMs) return { state: 'newer', snapshot }
      if (snapshot.updatedAt < serverMs) return { state: 'stale', snapshot }
      return { state: 'same', snapshot }
    }
  }
  return { state: 'newer', snapshot }
}