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
  SortControl,
  type SortField,
  type SortSpec,
} from '../../../components/execution'
import type { useBatchSelect } from '../../../hooks/useBatchSelect'
import type { PipelineViewProps } from './shared'

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
}: InReviewTabProps) {
  const { t } = useTranslation()
  return (
    /* 审核专注审核（v0.2.6）：异常内容移至独立「异常」menu——全宽单栏 */
    <div className="p-4">
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
    </div>
  )
}
