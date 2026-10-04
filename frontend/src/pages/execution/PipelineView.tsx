import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { PipelineItem } from '../../api'
import { TabBar } from '../../components/ui'
import type { SortSpec } from '../../components/execution'
import { useBatchSelect } from '../../hooks/useBatchSelect'
import { RunTab } from './pipeline/RunTab'
import { PreReviewTab } from './pipeline/PreReviewTab'
import { InReviewTab, type AuditStage, type BatchRunAction } from './pipeline/InReviewTab'
import { ExceptionsTab, type ExSubTabId } from './pipeline/ExceptionsTab'
import { ScriptWorkshop } from '../../components/execution/ScriptWorkshop'
import { useExecutionStore } from '../../stores/execution'
import type { PreStage } from '../../stores/execution'
import { PIPELINE_TABS, type PipelineTabId, type PipelineViewProps } from './pipeline/shared'

// ================= Pipeline 域 =================
// v0.20 拆分（D-183）：「state 留壳、JSX 下放」——本组件持有全部状态/派生数据/快捷键，
// 五个 tab 组件（pipeline/*.tsx）为纯结构下放，经 props 接收，零行为变化。

export function PipelineView(p: PipelineViewProps) {
  const { t } = useTranslation()
  // 批量生产方式（v0.3.3，预处理）
  const [produceBatchOpen, setProduceBatchOpen] = useState(false)
  // 预处理排序（v0.3.12）：要素 × 方向两维度；默认 入库序+降序（最新在前）
  const [preSort, setPreSort] = useState<SortSpec>({ field: 'seq', dir: 'desc' })
  // 预处理阶段子菜单（v0.8.8）：未评分 / 已评分未下载 / 已下载未加工——
  // v0.34：这份状态搬进 `stores/execution`（不再 local state）——顶级看板的
  // 「去未评分筛素材」动线在另一个页面上，它要一次把「分段 + 三轴 + tab」都设好；
  // 留在壳里就跨不过去，动线只能做成半根线（上轮实测到的）。
  const preStage = useExecutionStore((s) => s.pipeline.preStage)
  const setPreStage = (v: PreStage) => useExecutionStore.getState().setPipeline({ preStage: v })
  const sortPreList = useMemo(() => {
    const seqOf = (item: PipelineItem) => item.seq ?? (item.created_at ? Date.parse(item.created_at) : 0)
    const updatedOf = (item: PipelineItem) =>
      item.updated_at ? Date.parse(item.updated_at) : seqOf(item)
    const sign = preSort.dir === 'asc' ? 1 : -1
    return (list: PipelineItem[]): PipelineItem[] => {
      const copy = [...list]
      switch (preSort.field) {
        case 'score':
          return copy.sort((a, b) => sign * ((b.score_total ?? -1) - (a.score_total ?? -1)))
        case 'updated':
          return copy.sort((a, b) => sign * (updatedOf(a) - updatedOf(b)))
        case 'produce': {
          // 生产方式组合排序：直发优先展示（无需加工最快），其余按模块数
          const key = (i: PipelineItem): number => {
            const o = i.produce_options ?? {}
            if ((o as { passthrough?: boolean }).passthrough) return 0
            return Object.values(o).filter(Boolean).length
          }
          return copy.sort((a, b) => key(a) - key(b) || sign * (seqOf(a) - seqOf(b)))
        }
        default:
          return copy.sort((a, b) => sign * (seqOf(a) - seqOf(b)))
      }
    }
  }, [preSort])
  // 审核排序（v0.3.12）：要素 × 方向 + 独立开关「有成片优先 / 随机洗牌」
  const [auditSort, setAuditSort] = useState<SortSpec>({ field: 'seq', dir: 'desc' })
  // 审核页次级分段（v0.34 D-218）：待审｜已过审待发。留主壳（D-183：state 留壳，tab 只拿 props）
  const [auditStage, setAuditStage] = useState<AuditStage>('queued')
  // 审核搜索（v0.8.9）：标题关键词过滤
  const [auditQuery, setAuditQuery] = useState('')
  const [videoFirst, setVideoFirst] = useState(true)
  const [auditRandom, setAuditRandom] = useState(false)
  // 低分复用池（v0.5 D）：仅看 is_lowscore 条目
  const [lowScoreOnly, setLowScoreOnly] = useState(false)
  const [randomSeed, setRandomSeed] = useState(0)
  function toggleAuditRandom() {
    const next = !auditRandom
    setAuditRandom(next)
    if (next) setRandomSeed(Date.now())  // 每次开启重新洗牌
  }
  const sortedQueued = useMemo(() => {
    const list = [...p.stageQueued]
    // 入库顺序（v0.3.1）：seq 自增序号优先（同批 created_at 相同无法区分先后），
    // 旧数据无 seq 时回退 created_at 时间戳
    const seqOf = (item: PipelineItem) => item.seq ?? (item.created_at ? Date.parse(item.created_at) : 0)
    const updatedOf = (item: PipelineItem) =>
      item.updated_at ? Date.parse(item.updated_at) : seqOf(item)
    const sign = auditSort.dir === 'asc' ? 1 : -1
    if (auditRandom) {
      // 每次开启随机生成一次洗牌（seed 变化触发重排），而非每帧重排
      const shuffled = [...list]
      for (let i = shuffled.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
      }
      return shuffled
    }
    let sorted: PipelineItem[]
    switch (auditSort.field) {
      case 'score':
        sorted = list.sort((a, b) => sign * ((b.score_total ?? -1) - (a.score_total ?? -1)))
        break
      case 'reddit':
        sorted = list.sort((a, b) => sign * (a.reddit_score - b.reddit_score))
        break
      case 'title':
        sorted = list.sort((a, b) => sign * a.title.localeCompare(b.title, 'zh'))
        break
      case 'updated':
        sorted = list.sort((a, b) => sign * (updatedOf(a) - updatedOf(b)))
        break
      default:
        sorted = list.sort((a, b) => sign * (seqOf(a) - seqOf(b)))
    }
    if (videoFirst) {
      // 有成片优先：可预览的排前面，同组内保持当前排序
      const withVideo = sorted.filter((i) => i.video_path)
      const rest = sorted.filter((i) => !i.video_path)
      sorted = [...withVideo, ...rest]
    }
    // 低分复用池（v0.5 D）：仅看 is_lowscore 时过滤
    if (lowScoreOnly) sorted = sorted.filter((i) => i.is_lowscore)
    // 审核搜索（v0.8.9）：标题关键词（大小写不敏感）
    const q = auditQuery.trim().toLowerCase()
    if (q) sorted = sorted.filter((i) => (i.title || '').toLowerCase().includes(q))
    return sorted
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.stageQueued, auditSort, videoFirst, auditRandom, randomSeed, lowScoreOnly, auditQuery])
  const pTab: PipelineTabId = PIPELINE_TABS.some((tb) => tb.id === p.tab)
    ? (p.tab as PipelineTabId)
    : 'inReview'

  // ---- 审核效率（v0.4 A1 快捷键 / A2 批量 / wave10.1 批量选择模式） ----
  const [auditFocus, setAuditFocus] = useState<string | null>(null)
  const auditSel = useBatchSelect(sortedQueued)

  // ---- 异常区次级 tab（wave10）：低分池｜异常｜归档清理｜备用库 ----
  const [exTab, setExTab] = useState<ExSubTabId>('exceptions')
  // 低分回收池（v0.5 D）：is_lowscore 条目批量恢复待审（可复用）
  const lowscorePool = useMemo(
    () => [...p.stageQueued, ...p.stageRejected, ...p.stageFailed].filter((i) => i.is_lowscore),
    [p.stageQueued, p.stageRejected, p.stageFailed],
  )
  // 归档清理候选（wave10）：终态条目；备用库条目不重复展示
  const archivePool = useMemo(
    () =>
      [...p.stageApproved, ...p.stagePublished, ...p.stageFailed, ...p.stageRejected].filter(
        (i) => !i.archived,
      ),
    [p.stageApproved, p.stagePublished, p.stageFailed, p.stageRejected],
  )
  const archiveSel = useBatchSelect(archivePool)
  const backupSel = useBatchSelect(p.archivedItems)
  const toggleSelect = auditSel.toggle

  // j/k 导航 + a/r/b 操作（仅 inReview tab；输入框/⌘ 组合键不拦截）
  useEffect(() => {
    if (pTab !== 'inReview') {
      setAuditFocus(null)
      auditSel.exit()
      return
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const tgt = e.target
      if (
        tgt instanceof HTMLInputElement ||
        tgt instanceof HTMLTextAreaElement ||
        tgt instanceof HTMLSelectElement
      ) {
        return
      }
      const list = sortedQueued
      if (list.length === 0) return
      let idx = auditFocus ? list.findIndex((i) => i.id === auditFocus) : -1
      const move = (next: number) => {
        e.preventDefault()
        setAuditFocus(list[Math.max(0, Math.min(next, list.length - 1))].id)
      }
      // 批量选择模式（wave10.1）：a/r/b 忽略，防与批量操作混淆
      if (auditSel.mode && ['a', 'A', 'r', 'R', 'b', 'B'].includes(e.key)) return
      switch (e.key) {
        case 'j':
        case 'J':
        case 'ArrowDown':
          move(idx + 1)
          break
        case 'k':
        case 'K':
        case 'ArrowUp':
          move(idx < 0 ? 0 : idx - 1)
          break
        case 'a':
        case 'A':
          if (idx >= 0) {
            e.preventDefault()
            void p.act(list[idx], 'approve')
            setAuditFocus(null)
          }
          break
        case 'r':
        case 'R':
          if (idx >= 0) {
            e.preventDefault()
            void p.act(list[idx], 'reject')
            setAuditFocus(null)
          }
          break
        case 'b':
        case 'B':
          if (idx >= 0) {
            e.preventDefault()
            void p.backToPrep(list[idx])
            setAuditFocus(null)
          }
          break
        case 'Enter':
          // 展开/折叠焦点卡文案（v0.26 运营面板：Enter 不碰鼠标看全文）
          if (idx >= 0) {
            e.preventDefault()
            const el = document.querySelector(
              `#audit-item-${list[idx].id} details`,
            ) as HTMLDetailsElement | null
            if (el) el.open = !el.open
          }
          break
        case 'Escape':
          setAuditFocus(null)
          if (auditSel.mode) auditSel.exit()
          else auditSel.clear()
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pTab, sortedQueued, auditFocus, auditSel.mode])

  // 焦点项滚动到可视区（列表长时 j/k 不迷路）
  useEffect(() => {
    if (!auditFocus) return
    document
      .getElementById(`audit-item-${auditFocus}`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [auditFocus])

  // 批量操作（wave10.1 批量选择模式）
  const selectedItems = auditSel.selected
  function batchRun(action: BatchRunAction) {
    void p.batchAction(action, [...auditSel.sel])
    auditSel.clear()
  }

  // 进入审核自动维护排期（v0.2.7）：过期重排 + 未排期自动分配。
  // 会话内只触发一次（v0.2.8）——切 tab 往返不再重复分配，避免排期越排越远
  const rescheduleRef = useRef(false)
  useEffect(() => {
    if (pTab === 'inReview' && !rescheduleRef.current) {
      rescheduleRef.current = true
      void p.rescheduleExpired()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pTab])

  const tabItems = PIPELINE_TABS.map((tb) => ({
    id: tb.id,
    label: t(tb.labelKey),
    // 异常 menu 与正常流程分隔（v0.2.7）：wave10.2 推至单行最右侧独立区
    dividerBefore: tb.id === 'exceptions',
    end: tb.id === 'exceptions',
    count: tb.countKeys
      ? tb.countKeys.reduce((sum, k) => sum + (p.counts[k] ?? 0), 0)
      : undefined,
  }))

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 平铺菜单栏（第三级路由）：TabBar 统一语言 */}
      <div className="shrink-0 border-b border-border px-4">
        <TabBar items={tabItems} active={pTab} onChange={p.setTab} />
      </div>

      {/* 内容区（当前部分，独立滚动）；key 化触发切换淡入（v0.2.6 消除抖动观感） */}
      <div key={pTab} className="hz-fade-in min-h-0 flex-1 overflow-y-auto">
        {pTab === 'run' && <RunTab p={p} />}

        {pTab === 'workshop' && <ScriptWorkshop />}

        {pTab === 'preReview' && (
          <PreReviewTab
            p={p}
            preStage={preStage}
            setPreStage={setPreStage}
            preSort={preSort}
            setPreSort={setPreSort}
            sortPreList={sortPreList}
            produceBatchOpen={produceBatchOpen}
            setProduceBatchOpen={setProduceBatchOpen}
          />
        )}
        {pTab === 'inReview' && (
          <InReviewTab
            p={p}
            sortedQueued={sortedQueued}
            auditFocus={auditFocus}
            auditSel={auditSel}
            toggleSelect={toggleSelect}
            selectedItems={selectedItems}
            batchRun={batchRun}
            auditQuery={auditQuery}
            setAuditQuery={setAuditQuery}
            lowScoreOnly={lowScoreOnly}
            setLowScoreOnly={setLowScoreOnly}
            videoFirst={videoFirst}
            setVideoFirst={setVideoFirst}
            auditRandom={auditRandom}
            toggleAuditRandom={toggleAuditRandom}
            auditSort={auditSort}
            setAuditSort={setAuditSort}
            auditStage={auditStage}
            setAuditStage={setAuditStage}
          />
        )}

        {/* 异常（独立 menu，v0.2.6）：次级 tab——低分池｜异常｜归档清理｜备用库（wave10 删除统一收口） */}
        {pTab === 'exceptions' && (
          <ExceptionsTab
            p={p}
            exTab={exTab}
            setExTab={setExTab}
            lowscorePool={lowscorePool}
            archivePool={archivePool}
            archiveSel={archiveSel}
            backupSel={backupSel}
          />
        )}

      </div>
    </div>
  )
}
