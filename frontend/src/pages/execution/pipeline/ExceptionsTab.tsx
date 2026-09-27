/** Pipeline 异常 tab（v0.20 拆分，D-183）：低分池｜异常｜归档清理｜备用库 次级导航。
 *  纯结构移动自 PipelineView（原 854-1160 行段），零行为变化；state 留主壳经 props 下发。 */

import { useTranslation } from 'react-i18next'

import type { Dispatch, SetStateAction } from 'react'

import { INVALID_POOL_LIMIT, type PipelineItem } from '../../../api'
import { Badge, Button, Icon, QueryErrorState } from '../../../components/ui'
import {
  PIPELINE_ITEM_TONE,
  SectionCard,
  StageItemRow,
  StageList,
} from '../../../components/execution'
import type { useBatchSelect } from '../../../hooks/useBatchSelect'
import type { PipelineViewProps } from './shared'

// 异常区次级 tab（wave10，v0.33 加空壳池）：低分池｜异常｜空壳｜归档清理｜备用库
export const EX_SUB_TABS = ['lowscore', 'exceptions', 'invalid', 'archive', 'backup'] as const
export type ExSubTabId = (typeof EX_SUB_TABS)[number]

interface ExceptionsTabProps {
  p: PipelineViewProps
  exTab: ExSubTabId
  setExTab: Dispatch<SetStateAction<ExSubTabId>>
  /** 低分回收池：is_lowscore 条目（主壳派生） */
  lowscorePool: PipelineItem[]
  /** 归档清理候选：终态未归档条目（主壳派生） */
  archivePool: PipelineItem[]
  archiveSel: ReturnType<typeof useBatchSelect>
  backupSel: ReturnType<typeof useBatchSelect>
}

export function ExceptionsTab({
  p,
  exTab,
  setExTab,
  lowscorePool,
  archivePool,
  archiveSel,
  backupSel,
}: ExceptionsTabProps) {
  const { t } = useTranslation()
  return (
    <div className="p-4">
      <div className="mb-3 flex items-center gap-1">
        {EX_SUB_TABS.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => {
              setExTab(id)
              // 切换次级 tab：退出批量选择模式，避免残留选中
              archiveSel.exit()
              backupSel.exit()
            }}
            className={`px-2.5 py-1 text-xs transition-colors ${
              exTab === id
                ? 'bg-surface-2 font-medium text-text-primary'
                : 'text-text-secondary hover:bg-surface-2/60'
            }`}
          >
            {t(`console.exTab.${id}`)}
          </button>
        ))}
      </div>

      {/* 低分回收池（v0.5 D）：is_lowscore 条目批量恢复待审（可复用） */}
      {exTab === 'lowscore' && (
        <SectionCard
          title={`${t('console.lowScorePool')} (${lowscorePool.length})`}
          padded={false}
        >
          {lowscorePool.length === 0 ? (
            <p className="p-3 text-sm text-text-disabled">{t('console.noExceptions')}</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-1.5 border-b border-border/60 px-3 py-2">
                <p className="text-xs text-text-secondary">{t('console.lowScorePoolHint')}</p>
                <Button
                  size="sm"
                  variant="secondary"
                  className="ml-auto"
                  onClick={() => void p.batchAction('requeue', lowscorePool.map((i) => i.id))}
                >
                  <Icon name="refresh" size={12} />
                  {t('console.lowScoreRestoreAll', { n: lowscorePool.length })}
                </Button>
              </div>
              <StageList
                items={lowscorePool}
                emptyText={t('console.noExceptions')}
                renderRow={(item) => (
                  <StageItemRow
                    item={item}
                    badge={<Badge tone="warning">low</Badge>}
                    right={
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={p.busy[item.id]?.action === 'requeue'}
                        disabled={!!p.busy[item.id]}
                        onClick={() => void p.act(item, 'requeue')}
                      >
                        {t('console.restore')}
                      </Button>
                    }
                  />
                )}
              />
            </>
          )}
        </SectionCard>
      )}

      {/* 空壳池（v0.33）：无媒体且无正文的条目——已从流水线计数与步骤里隔离，
          但仍留在库里参与 source_id 去重（重复抓取时直接跳过）。原因逐条显示。 */}
      {exTab === 'invalid' && (
        <SectionCard
          title={`${t('console.invalidPool')} (${p.invalidItems.length}${
            // 接口按 limit=200 截断：不带「+」就会把「取到的条数」读成「总数」，
            // 而这片的目标恰恰是让数字诚实
            p.invalidItems.length >= INVALID_POOL_LIMIT ? '+' : ''
          })`}
          padded={false}
        >
          {p.invalidItems.length === 0 ? (
            <p className="p-3 text-sm text-text-disabled">{t('console.noExceptions')}</p>
          ) : (
            <>
              <p className="border-b border-border/60 px-3 py-2 text-xs text-text-secondary">
                {t('console.invalidPoolHint')}
              </p>
              <StageList
                items={p.invalidItems}
                emptyText={t('console.noExceptions')}
                renderRow={(item) => (
                  <>
                    <StageItemRow
                      item={item}
                      badge={<Badge tone="neutral">{t('console.invalidBadge')}</Badge>}
                    />
                    {item.error && (
                      <p className="px-3 pb-1 text-[11px] leading-relaxed text-text-disabled">
                        {item.error}
                      </p>
                    )}
                  </>
                )}
              />
            </>
          )}
        </SectionCard>
      )}

      {/* 异常：失败分类看板 + 拒绝/失败条目 */}
      {exTab === 'exceptions' && (
        <SectionCard title={t('console.exceptions')} padded={false}>
          {p.stageError ? (
            <QueryErrorState message={t('error.queryFailed', { detail: 'pipeline' })} onRetry={() => void p.refetchStage()} />
          ) : p.stageFailed.length + p.stageRejected.length === 0 ? (
            <p className="p-3 text-sm text-text-disabled">{t('console.noExceptions')}</p>
          ) : (
            <>
              {/* 失败分类看板（v0.2.1）：按类统计 + 同类批量重试 */}
              {Object.keys(p.failures).length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 border-b border-border/60 px-3 py-2">
                  {Object.entries(p.failures).map(([cls, n]) => (
                    <span key={cls} className="inline-flex items-center gap-1.5 border border-border bg-surface-2/60 px-2 py-0.5 text-[11px] text-text-secondary">
                      <span className="font-mono">{cls}</span>
                      <span className="text-text-disabled">{n}</span>
                      <button
                        type="button"
                        onClick={() => void p.retryClass(cls, n)}
                        title={`${t('console.retryClassHint', { cls })}\n${t(`errors.suggestion.${cls}`, { defaultValue: '' })}`}
                        className=" p-0.5 text-text-disabled transition-colors hover:text-primary"
                      >
                        <Icon name="refresh" size={11} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <StageList
                items={[...p.stageRejected, ...p.stageFailed]}
                emptyText={t('console.noExceptions')}
                total={(p.counts.rejected ?? 0) + (p.counts.failed ?? 0)}
                renderRow={(item) => (
                  <StageItemRow
                    item={item}
                    badge={<Badge tone={PIPELINE_ITEM_TONE[item.status] ?? 'neutral'}>{item.status}</Badge>}
                    right={
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          loading={p.busy[item.id]?.action === 'retranslate'}
                          disabled={!!p.busy[item.id]}
                          onClick={() => void p.act(item, 'retranslate')}
                          title={t('console.retranslateHint')}
                        >
                          {t('console.retranslate')}
                        </Button>
                        {item.status === 'failed' ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            loading={p.busy[item.id]?.action === 'retry'}
                            disabled={!!p.busy[item.id]}
                            onClick={() => void p.act(item, 'retry')}
                          >
                            {t('common.retry')}
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="ghost"
                            loading={p.busy[item.id]?.action === 'requeue'}
                            disabled={!!p.busy[item.id]}
                            onClick={() => void p.act(item, 'requeue')}
                          >
                            {t('console.restore')}
                          </Button>
                        )}
                      </>
                    }
                  />
                )}
              />
            </>
          )}
        </SectionCard>
      )}

      {/* 归档清理（wave10）：终态条目批量归档——磁盘清理 + 数据清洗，入口仅此一处 */}
      {exTab === 'archive' && (
        <SectionCard title={`${t('console.exTab.archive')} (${archivePool.length})`} padded={false}>
          {/* 批量模式条带（wave10.1）：已选 n · 全选 · 归档所选 · 退出 */}
          {archiveSel.mode ? (
            <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-border bg-surface-2/80 px-3 py-2 text-xs backdrop-blur-sm">
              <span className="font-medium text-text-primary">
                {t('console.batchSelected', { n: archiveSel.selected.length })}
              </span>
              <button
                type="button"
                onClick={archiveSel.toggleAll}
                className="text-[11px] text-text-secondary transition-colors hover:text-text-primary"
              >
                {archiveSel.sel.size === archivePool.length
                  ? t('console.batchDeselectAll')
                  : t('console.batchSelectAll')}
              </button>
              <span className="text-text-disabled">{t('console.batchSelectHint')}</span>
              <span className="ml-auto flex items-center gap-1.5">
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => void p.archiveItems(archiveSel.selected)}
                >
                  <Icon name="trash" size={12} />
                  {t('console.archiveSelected', { n: archiveSel.selected.length })}
                </Button>
                <Button size="sm" variant="ghost" onClick={archiveSel.exit}>
                  {t('console.batchModeExitShort')}
                </Button>
              </span>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-1.5 border-b border-border/60 px-3 py-2">
              <p className="text-xs text-text-secondary">{t('console.archivePoolHint')}</p>
              <span className="ml-auto flex items-center gap-1.5">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={archivePool.length === 0}
                  onClick={archiveSel.enter}
                >
                  {t('console.batchModeEnter')}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={archivePool.length === 0}
                  onClick={() => void p.archiveItems(archivePool)}
                >
                  <Icon name="trash" size={12} />
                  {t('console.archiveAll', { n: archivePool.length })}
                </Button>
              </span>
            </div>
          )}
          <StageList
            items={archivePool}
            emptyText={t('console.archivePoolEmpty')}
            renderRow={(item) => (
              <StageItemRow
                item={item}
                selectMode={archiveSel.mode}
                selected={archiveSel.sel.has(item.id)}
                onSelect={archiveSel.toggle}
                badge={<Badge tone={PIPELINE_ITEM_TONE[item.status] ?? 'neutral'}>{item.status}</Badge>}
              />
            )}
          />
        </SectionCard>
      )}

      {/* 备用库（wave10）：archived 条目——恢复或彻底删除 */}
      {exTab === 'backup' && (
        <SectionCard title={`${t('console.exTab.backup')} (${p.archivedItems.length})`} padded={false}>
          {/* 批量模式条带（wave10.1）：已选 n · 全选 · 恢复/彻底删除 · 退出 */}
          {backupSel.mode ? (
            <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-border bg-surface-2/80 px-3 py-2 text-xs backdrop-blur-sm">
              <span className="font-medium text-text-primary">
                {t('console.batchSelected', { n: backupSel.selected.length })}
              </span>
              <button
                type="button"
                onClick={backupSel.toggleAll}
                className="text-[11px] text-text-secondary transition-colors hover:text-text-primary"
              >
                {backupSel.sel.size === p.archivedItems.length
                  ? t('console.batchDeselectAll')
                  : t('console.batchSelectAll')}
              </button>
              <span className="text-text-disabled">{t('console.batchSelectHint')}</span>
              <span className="ml-auto flex items-center gap-1.5">
                <Button size="sm" variant="secondary" onClick={() => void p.unarchiveItems(backupSel.selected)}>
                  <Icon name="rewind" size={12} />
                  {t('console.restoreSelected', { n: backupSel.selected.length })}
                </Button>
                <Button size="sm" variant="danger" onClick={() => void p.purgeItems(backupSel.selected)}>
                  <Icon name="trash" size={12} />
                  {t('console.purgeSelected', { n: backupSel.selected.length })}
                </Button>
                <Button size="sm" variant="ghost" onClick={backupSel.exit}>
                  {t('console.batchModeExitShort')}
                </Button>
              </span>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-1.5 border-b border-border/60 px-3 py-2">
              <p className="text-xs text-text-secondary">{t('console.backupHint')}</p>
              <span className="ml-auto flex items-center gap-1.5">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={p.archivedItems.length === 0}
                  onClick={backupSel.enter}
                >
                  {t('console.batchModeEnter')}
                </Button>
              </span>
            </div>
          )}
          <StageList
            items={p.archivedItems}
            emptyText={t('console.backupEmpty')}
            renderRow={(item) => (
              <StageItemRow
                item={item}
                selectMode={backupSel.mode}
                selected={backupSel.sel.has(item.id)}
                onSelect={backupSel.toggle}
                badge={<Badge tone={PIPELINE_ITEM_TONE[item.status] ?? 'neutral'}>{item.status}</Badge>}
                right={
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void p.unarchiveItems([item])}
                    >
                      {t('console.restore')}
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => void p.purgeItems([item])}
                    >
                      <Icon name="trash" size={12} />
                    </Button>
                  </>
                }
              />
            )}
          />
        </SectionCard>
      )}
    </div>
  )
}
