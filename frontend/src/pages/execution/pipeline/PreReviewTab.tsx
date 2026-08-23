/** Pipeline 预处理 tab（v0.20 拆分，D-183）：三阶段子菜单导航 + 排序/批量操作。
 *  纯结构移动自 PipelineView（原 552-712 行段），零行为变化；state 留主壳经 props 下发。 */

import { useTranslation } from 'react-i18next'

import type { Dispatch, SetStateAction } from 'react'

import type { PipelineItem } from '../../../api'
import { Button, Icon, Select } from '../../../components/ui'
import {
  PipelineStage,
  PreReviewCard,
  PreReviewRow,
  SortControl,
  StageList,
  type SortField,
  type SortSpec,
} from '../../../components/execution'
import { ProduceBatchModal } from '../../../components/execution/ProduceBatchModal'
import type { PipelineViewProps } from './shared'

// 排序要素（v0.3.12 两维度：要素 × 方向）
const PRE_SORT_FIELDS: SortField[] = [
  { id: 'seq', labelKey: 'console.sort.seq' },
  { id: 'score', labelKey: 'console.sort.score' },
  { id: 'produce', labelKey: 'console.sort.produce' },
  { id: 'updated', labelKey: 'console.sort.updated' },
]

export type PreStage = 'discovered' | 'scored' | 'downloaded'

interface PreReviewTabProps {
  p: PipelineViewProps
  preStage: PreStage
  setPreStage: (v: PreStage) => void
  preSort: SortSpec
  setPreSort: Dispatch<SetStateAction<SortSpec>>
  sortPreList: (list: PipelineItem[]) => PipelineItem[]
  produceBatchOpen: boolean
  setProduceBatchOpen: (v: boolean) => void
}

export function PreReviewTab({
  p,
  preStage,
  setPreStage,
  preSort,
  setPreSort,
  sortPreList,
  produceBatchOpen,
  setProduceBatchOpen,
}: PreReviewTabProps) {
  const { t } = useTranslation()
  return (
    <div className="p-4">
      <PipelineStage
        title={`${t('console.stagePreReview')} · ${t(`console.preStage.${preStage}`)} (${p.counts[preStage] ?? 0})`}
        right={
          <div className="flex items-center gap-1.5">
            {/* 预处理排序（v0.3.12）：要素 × 方向 */}
            <SortControl
              fields={PRE_SORT_FIELDS}
              sort={preSort}
              onSort={setPreSort}
            />
            <span className="flex items-center gap-1.5 border-l border-border pl-2">
              <Select
                aria-label={t('console.limit')}
                value={String(p.limit)}
                onChange={(e) => p.setLimit(Number(e.target.value))}
                options={[5, 10, 25, 50].map((n) => ({ value: String(n), label: String(n) }))}
                className="w-20"
              />
              {/* 当前阶段的批量操作（v0.8.8）：未评分→评分/直下 / 已评分→下载 / 已下载→制作 */}
              {preStage === 'discovered' && (
                <>
                  <Button
                    size="sm"
                    onClick={() => void p.scoreBatch()}
                    title={t('console.scoreBatchHint')}
                  >
                    <Icon name="whisper" size={12} />
                    {t('console.scoreBatch')}
                  </Button>
                  {/* 直接下载（v0.11.10）：跳过评分省 API 用量——样式对应 scored 批量下载 */}
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void p.downloadBatchUnscored()}
                    title={t('console.downloadUnscoredHint')}
                  >
                    <Icon name="downloads" size={12} />
                    {t('console.downloadUnscored')}
                  </Button>
                </>
              )}
              {preStage === 'scored' && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void p.runStep('download')}
                  disabled={p.running}
                  title={t('console.downloadHint')}
                >
                  <Icon name="downloads" size={12} />
                  {t('console.downloadBatch')}
                </Button>
              )}
              {preStage === 'downloaded' && (
                <Button
                  size="sm"
                  onClick={() => void p.produceBatch()}
                  title={t('console.produce.batchProduceHint')}
                >
                  <Icon name="play" size={12} />
                  {t('console.produce.batchProduce')}
                </Button>
              )}
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setProduceBatchOpen(true)}
                title={t('console.produce.batchHint')}
              >
                <Icon name="config" size={12} />
                {t('console.produce.batch')}
              </Button>
            </span>
          </div>
        }
      >
        {/* 阶段子菜单（v0.8.8）：三个可导航分段——点击切换查看该阶段数据；
            待审核已移除（归审核页签）。分段控件风格：激活段填充高亮 */}
        <div
          role="tablist"
          aria-label={t('console.stagePreReview')}
          className="flex gap-1 border-b border-border bg-surface-2/40 px-3 py-2"
        >
          {(
            [
              { key: 'discovered', n: p.counts.discovered ?? 0 },
              { key: 'scored', n: p.counts.scored ?? 0 },
              { key: 'downloaded', n: p.counts.downloaded ?? 0 },
            ] as const
          ).map((seg) => {
            const active = preStage === seg.key
            return (
              <button
                key={seg.key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setPreStage(seg.key)}
                className={`flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs transition-colors ${
                  active
                    ? 'bg-surface-1 font-medium text-text-primary shadow-sm ring-1 ring-border'
                    : 'text-text-secondary hover:bg-surface-1/50 hover:text-text-primary'
                }`}
              >
                <span className="truncate">{t(`console.preStage.${seg.key}`)}</span>
                <span className={`shrink-0 font-mono text-[10px] ${active ? 'text-text-secondary' : 'text-text-disabled'}`}>
                  {seg.n}
                </span>
              </button>
            )
          })}
        </div>

        {/* 当前阶段数据列表（单阶段渲染——菜单即导航） */}
        <StageList
          items={
            preStage === 'discovered'
              ? sortPreList(p.stageDiscovered)
              : preStage === 'scored'
                ? sortPreList(p.stageScored)
                : sortPreList(p.stageDownloaded)
          }
          emptyText={t(`console.preEmpty.${preStage}`)}
          total={p.counts[preStage] ?? 0}
          renderRow={(item) =>
            preStage === 'downloaded' ? (
              // 已下载未加工：卡式（生产方式选择需要空间）
              <PreReviewCard
                key={item.id}
                item={item}
                onSaveOptions={(i, options) => void p.setProduceOptions([i], options)}
                onProduce={(i) => void p.produceOne(i)}
                onCancelProduce={(i) => void p.cancelProduceOne(i)}
                onReject={(i) => void p.act(i, 'reject')}
                onUploadCover={(i, file) => void p.uploadCover(i, file)}
              />
            ) : (
              // 未评分/已评分：紧凑行（v0.8.9 三阶段差异化——列表式浏览）
              <PreReviewRow
                key={item.id}
                item={item}
                stage={preStage}
                onScore={(i) => void p.scoreOne(i)}
                onDownload={(i) => void p.downloadOne(i)}
                onDownloadDirect={(i) => void p.downloadOneDirect(i)}
                onReject={(i) => void p.act(i, 'reject')}
              />
            )
          }
        />
      </PipelineStage>
      <ProduceBatchModal
        open={produceBatchOpen}
        onClose={() => setProduceBatchOpen(false)}
        items={[...p.stageDownloaded, ...p.stageScored]}
        onApply={(items, options) => void p.setProduceOptions(items, options)}
      />
    </div>
  )
}
