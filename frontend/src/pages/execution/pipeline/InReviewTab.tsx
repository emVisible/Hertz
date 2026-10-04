/** Pipeline 审核 tab（v0.20 拆分，D-183）：审核卡列表 + 批量选择/筛选/排序控件。
 *  纯结构移动自 PipelineView（原 713-851 行段），零行为变化；state 留主壳经 props 下发
 *  （j/k 快捷键与批量选择逻辑仍在主壳——跨 tab 监听需常驻）。 */

import { useTranslation } from 'react-i18next'

import type { Dispatch, SetStateAction } from 'react'

import type { PipelineItem } from '../../../api'
import { Button, Icon } from '../../../components/ui'
import {
  AuditCard,
  PipelineStage,
  PublishCard,
  SortControl,
  TodayPick,
  type SortField,
  type SortSpec,
} from '../../../components/execution'
import type { useBatchSelect } from '../../../hooks/useBatchSelect'
import type { PipelineViewProps } from './shared'

/** 审核页的次级分段（v0.34 D-218）：`待审` 之外补上 **已过审待发**。
 *  补的是个洞：D-213 把「发布」tab 并进看板之后，`approved` 条目在整个界面里只剩
 *  看板「待处理」那一列这一个落点；D-218 用户说那一列不该在看板上，于是单条发布
 *  的入口搬到这里——不搬就等于界面上再也发不出去。 */
export type AuditStage = 'queued' | 'approved'

// 排序要素（v0.3.12 两维度：要素 × 方向）
const AUDIT_SORT_FIELDS: SortField[] = [
  { id: 'seq', labelKey: 'console.sort.seq' },
  { id: 'score', labelKey: 'console.sort.score' },
  { id: 'reddit', labelKey: 'console.sort.reddit' },
  { id: 'title', labelKey: 'console.sort.title' },
  { id: 'updated', labelKey: 'console.sort.updated' },
]

export type BatchRunAction = 'approve' | 'reject' | 'back_to_prep'

interface InReviewTabProps {
  p: PipelineViewProps
  /** 主壳排序/筛选/搜索后的待审列表 */
  sortedQueued: PipelineItem[]
  /** 次级分段（v0.34 D-218）：待审 / 已过审待发。留主壳（D-183）。 */
  auditStage: AuditStage
  setAuditStage: (v: AuditStage) => void
  auditFocus: string | null
  auditSel: ReturnType<typeof useBatchSelect>
  toggleSelect: (item: PipelineItem) => void
  selectedItems: PipelineItem[]
  batchRun: (action: BatchRunAction) => void
  auditQuery: string
  setAuditQuery: (v: string) => void
  lowScoreOnly: boolean
  setLowScoreOnly: Dispatch<SetStateAction<boolean>>
  videoFirst: boolean
  setVideoFirst: Dispatch<SetStateAction<boolean>>
  auditRandom: boolean
  toggleAuditRandom: () => void
  auditSort: SortSpec
  setAuditSort: Dispatch<SetStateAction<SortSpec>>
}

export function InReviewTab({
  p,
  sortedQueued,
  auditFocus,
  auditSel,
  toggleSelect,
  selectedItems,
  batchRun,
  auditQuery,
  setAuditQuery,
  lowScoreOnly,
  setLowScoreOnly,
  videoFirst,
  setVideoFirst,
  auditRandom,
  toggleAuditRandom,
  auditSort,
  setAuditSort,
  auditStage,
  setAuditStage,
}: InReviewTabProps) {
  const { t } = useTranslation()
  const segments = [
    // 计数用后端的 `counts`（截断前），不是列表长度——和预处理那三个分段同一口径
    { key: 'queued' as const, labelKey: 'console.boardColReview', n: p.counts.queued ?? p.stageQueued.length },
    { key: 'approved' as const, labelKey: 'console.approvedStage', n: p.counts.approved ?? p.stageApproved.length },
  ]
  return (
    /* 审核专注审核（v0.2.6）：异常内容移至独立「异常」menu——全宽单栏 */
    <div className="p-4">
      {/* 次级分段（v0.34 D-218）：样式跟预处理那三个分段一致 */}
      <div
        role="tablist"
        aria-label={t('console.stageAudit')}
        className="mb-2 flex gap-1 border-b border-border bg-surface-2/40 px-3 py-2"
      >
        {segments.map((seg) => {
          const active = auditStage === seg.key
          return (
            <button
              key={seg.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setAuditStage(seg.key)}
              className={`flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs transition-colors ${
                active
                  ? 'bg-surface-1 font-medium text-text-primary shadow-sm ring-1 ring-border'
                  : 'text-text-secondary hover:bg-surface-1/50 hover:text-text-primary'
              }`}
            >
              <span className="truncate">{t(seg.labelKey)}</span>
              <span className={`shrink-0 font-mono text-[10px] ${active ? 'text-text-secondary' : 'text-text-disabled'}`}>
                {seg.n}
              </span>
            </button>
          )
        })}
      </div>

      {auditStage === 'approved' && <ApprovedStage p={p} />}
      {auditStage === 'queued' && (
      <PipelineStage
        title={t('console.stageAudit')}
        isEmpty={p.stageQueued.length === 0}
        emptyText={t('console.emptyAudit')}
        right={
          <span className="flex items-center gap-1.5">
            {/* 批量组（wave10.1）：进入后点击卡片整卡选中 */}
            <span className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => (auditSel.mode ? auditSel.exit() : auditSel.enter())}
                title={t('console.batchModeHint')}
                className={`shrink-0 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                  auditSel.mode
                    ? 'border-primary/50 bg-primary/15 font-medium text-primary'
                    : 'border-transparent text-text-disabled hover:border-border hover:text-text-secondary'
                }`}
              >
                {auditSel.mode
                  ? t('console.batchModeExit', { n: selectedItems.length })
                  : t('console.batchModeEnter')}
              </button>
            </span>
            <span className="mx-1 h-4 w-px shrink-0 bg-border" aria-hidden />
            {/* 筛选组（v0.11.9 分组重排）：关键词 + 低分池 */}
            <span className="flex items-center gap-1">
              <input
                type="search"
                value={auditQuery}
                onChange={(e) => setAuditQuery(e.target.value)}
                placeholder={t('console.auditSearch')}
                className="h-6 w-40 rounded-sm border border-border bg-surface-1 px-2 text-[11px] text-text-primary outline-none placeholder:text-text-disabled focus:border-primary"
              />
              <button
                type="button"
                onClick={() => setLowScoreOnly((v) => !v)}
                title={t('console.lowScoreOnlyHint')}
                className={`shrink-0 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                  lowScoreOnly
                    ? 'border-warning/50 bg-warning/15 font-medium text-warning'
                    : 'border-transparent text-text-disabled hover:border-border hover:text-text-secondary'
                }`}
              >
                {t('console.lowScoreOnly')}
              </button>
            </span>
            <span className="mx-1 h-4 w-px shrink-0 bg-border" aria-hidden />
            {/* 排序组（v0.3.12）：要素 × 方向 + 视频优先/随机开关 */}
            <span className="flex items-center gap-1">
              <SortControl fields={AUDIT_SORT_FIELDS} sort={auditSort} onSort={setAuditSort} />
              <button
                type="button"
                onClick={() => setVideoFirst((v) => !v)}
                title={t('console.sort.videoFirstHint')}
                className={`shrink-0 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                  videoFirst
                    ? 'border-primary/40 bg-primary/15 font-medium text-primary'
                    : 'border-transparent text-text-disabled hover:border-border hover:text-text-secondary'
                }`}
              >
                {t('console.sort.videoFirst')}
              </button>
              <button
                type="button"
                onClick={toggleAuditRandom}
                title={t('console.sort.randomHint')}
                className={`shrink-0 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                  auditRandom
                    ? 'border-warning/50 bg-warning/15 font-medium text-warning'
                    : 'border-transparent text-text-disabled hover:border-border hover:text-text-secondary'
                }`}
              >
                🎲 {t('console.sort.random')}
              </button>
            </span>
          </span>
        }
      >
        {/* 批量操作条（wave10.1 批量选择模式）：进入模式常驻——已选 n · 全选 · 操作 */}
        {auditSel.mode && (
          <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-border bg-surface-2/80 px-3 py-2 text-xs backdrop-blur-sm">
            <span className="font-medium text-text-primary">
              {t('console.batchSelected', { n: selectedItems.length })}
            </span>
            <button
              type="button"
              onClick={auditSel.toggleAll}
              className="text-[11px] text-text-secondary transition-colors hover:text-text-primary"
            >
              {auditSel.sel.size === sortedQueued.length
                ? t('console.batchDeselectAll')
                : t('console.batchSelectAll')}
            </button>
            <span className="text-text-disabled">{t('console.batchSelectHint')}</span>
            <span className="ml-auto flex items-center gap-1.5">
              <Button size="sm" onClick={() => batchRun('approve')}>
                <Icon name="check" size={12} />
                {t('console.batchApprove')}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => batchRun('back_to_prep')}>
                <Icon name="rewind" size={12} />
                {t('console.batchBackToPrep')}
              </Button>
              <Button size="sm" variant="danger" onClick={() => batchRun('reject')}>
                <Icon name="close" size={12} />
                {t('console.batchReject')}
              </Button>
              <Button size="sm" variant="ghost" onClick={auditSel.exit}>
                {t('console.batchModeExitShort')}
              </Button>
            </span>
          </div>
        )}
        <ul className="divide-y divide-border/60">
          {sortedQueued.map((item) => (
              <AuditCard
                key={item.id}
                item={item}
                onApprove={(i) => void p.act(i, 'approve')}
                onReject={(i) => void p.act(i, 'reject')}
                onUploadCover={(i, file) => void p.uploadCover(i, file)}
                onRandomCover={(i) => void p.randomCover(i)}
                onBackToPrep={(i) => void p.backToPrep(i)}
                focused={auditFocus === item.id}
                selectMode={auditSel.mode}
                selected={auditSel.sel.has(item.id)}
                onSelect={toggleSelect}
              />
          ))}
        </ul>
        <p className="border-t border-border/60 px-3 py-2 text-[10px] text-text-disabled">
          {t('console.keyHint')}
        </p>
      </PipelineStage>
      )}
    </div>
  )
}

/** 已过审待发（v0.34 D-218）：逐条发布 + 捞入今日。
 *
 * 这一段的头**故意不给**待审那套搜索/低分/随机/排序控件——那些 state 只作用在
 * `sortedQueued` 上，把控件画在待发列表上就是「看着能筛、实际没发参数」的 UI 谎言
 * （预处理三轴那条踩过的同一形状）。approved 的量级也撑不起一套筛选。
 */
function ApprovedStage({ p }: { p: PipelineViewProps }) {
  const { t } = useTranslation()
  const approved = p.stageApproved
  return (
    <PipelineStage
      title={`${t('console.approvedStage')} (${p.counts.approved ?? approved.length})`}
      isEmpty={approved.length === 0}
      emptyText={t('console.approvedEmpty')}
    >
      <ul className="divide-y divide-border/60">
        {approved.map((item) => (
          <PublishCard
            key={item.id}
            item={item}
            pick={
              <TodayPick item={item} onPick={(i, day) => void p.setFocus(i, { focus_date: day })} />
            }
            onPublish={(i, selfmade, target, now) => void p.publishItem(i, selfmade, target, now)}
            onSaveMeta={(i, meta) => void p.saveMeta(i, meta)}
            onRequeue={(i) => void p.act(i, 'requeue')}
            onRandomCover={(i) => void p.randomCover(i)}
          />
        ))}
      </ul>
      <p className="border-t border-border/60 px-3 py-2 text-[10px] text-text-disabled">
        {t('console.approvedHint')}
      </p>
    </PipelineStage>
  )
}
