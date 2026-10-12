/** Pipeline 预处理 tab（v0.20 拆分，D-183）：三阶段子菜单导航 + 排序/批量操作。
 *  纯结构移动自 PipelineView（原 552-712 行段），零行为变化；state 留主壳经 props 下发。 */

import { useState } from 'react'
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
  TodayPick,
  type SortField,
  type SortSpec,
} from '../../../components/execution'
import { ProduceBatchModal } from '../../../components/execution/ProduceBatchModal'
import { CompilationModal } from '../../../components/execution/CompilationModal'
import type { PipelineViewProps } from './shared'
import type { PreStage } from '../../../stores/execution'

// 排序要素（v0.3.12 两维度：要素 × 方向）
const PRE_SORT_FIELDS: SortField[] = [
  { id: 'seq', labelKey: 'console.sort.seq' },
  { id: 'score', labelKey: 'console.sort.score' },
  { id: 'produce', labelKey: 'console.sort.produce' },
  { id: 'updated', labelKey: 'console.sort.updated' },
]

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
  /** 合集编排面板（v0.35）：页内 state——不进 store，因为它不是「跨页要记住的
   *  偏好」，而是「这次开面板选几条」的一次性操作态。 */
  const [compilationOpen, setCompilationOpen] = useState(false)
  /** 「捞入今日」（v0.34 D-218）：三段的行都挂，写点归 `p.setFocus`（唯一作者在 `usePipelineActions`）。 */
  const pick = (item: PipelineItem) => (
    <TodayPick item={item} onPick={(i, day) => void p.setFocus(i, { focus_date: day })} />
  )
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
                <>
                  <Button
                    size="sm"
                    onClick={() => void p.produceBatch()}
                    title={t('console.produce.batchProduceHint')}
                  >
                    <Icon name="play" size={12} />
                    {t('console.produce.batchProduce')}
                  </Button>
                  {/* 合集编排（v0.35）：入口只在已下载段——片段来源就是这一段
                      （服务端只认 status=downloaded 且有 raw 的条目），放在别的
                      段画出来就是「看着能建、必然 422」。 */}
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setCompilationOpen(true)}
                    title={t('console.compilation.hint')}
                  >
                    <Icon name="plans" size={12} />
                    {t('console.compilation.open')}
                  </Button>
                </>
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
        {/* 筛选条（v0.34 A）：两条轴，分段而异——
            「素材类型」三段都有（用户要求）：它是与阶段无关的「在筛什么素材」，
            三段共用 store 里同一个值，所以切段不丢选择，且每段都真的发了参数
            （usePipelineData 的 queueAll 查询带 material，见那里的注释）。
            主题/质量/正文三轴只服务 discovered 段——它们是**未评分期的决策输入**
            （质量轴靠 reddit_score/upvote_ratio，已评分之后那两个字段早就有结论了，
            在后两段画出来就是拿一个已过期的判据过滤）。把选择器画在不读它的段上，
            就是「看着能筛、实际没发参数」的 UI 谎言。 */}
        <div className="flex flex-wrap items-center gap-2 border-b border-border/60 bg-surface-2/20 px-3 py-2 text-xs">
          <span className="text-text-disabled">{t('console.preFilter.title')}</span>
          <Select
            aria-label={t('console.preFilter.material')}
            value={p.preFilters.material}
            onChange={(e) => p.setPreFilters({ preMaterial: e.target.value as never })}
            options={[
              { value: 'all', label: t('console.preFilter.materialAll') },
              { value: 'image', label: t('console.preFilter.materialImage') },
              { value: 'video', label: t('console.preFilter.materialVideo') },
              { value: 'text', label: t('console.preFilter.materialText') },
            ]}
            className="w-32"
          />
          {preStage === 'discovered' && (
            <>
              <Select
                aria-label={t('console.preFilter.theme')}
                value={p.preFilters.theme}
                onChange={(e) => p.setPreFilters({ preTheme: e.target.value as never })}
                options={[
                  { value: 'all', label: t('console.preFilter.themeAll') },
                  { value: 'sentiment', label: t('console.preFilter.themeSentiment') },
                ]}
                className="w-28"
              />
              <Select
                aria-label={t('console.preFilter.quality')}
                value={p.preFilters.quality}
                onChange={(e) => p.setPreFilters({ preQuality: e.target.value as never })}
                options={[
                  { value: 'all', label: t('console.preFilter.qualityAll') },
                  { value: 'loose', label: t('console.preFilter.qualityLoose') },
                  { value: 'standard', label: t('console.preFilter.qualityStandard') },
                  { value: 'strict', label: t('console.preFilter.qualityStrict') },
                ]}
                className="w-32"
              />
              <Select
                aria-label={t('console.preFilter.hasText')}
                value={p.preFilters.hasText}
                onChange={(e) => p.setPreFilters({ preHasText: e.target.value as never })}
                options={[
                  { value: 'all', label: t('console.preFilter.textAll') },
                  { value: 'yes', label: t('console.preFilter.textYes') },
                  { value: 'no', label: t('console.preFilter.textNo') },
                ]}
                className="w-28"
              />
            </>
          )}
          {/* total 与 hit 是两个数：把筛后当成全量，界面就分不清「筛没了」和「本来就没有」。 */}
          {preStage === 'discovered' && p.discoveredFacets && (
            <span className="ml-auto font-mono text-[10px] text-text-secondary">
              {t('console.preFilterProgress', {
                hit: p.discoveredFacets.hit,
                total: p.discoveredFacets.total,
              })}
              {/* 缺值单列：upvote_ratio 实测 17.2% 是采集缺省 0，不是零分赞 */}
              {' · '}
              {t('console.preFilterUnfilled', { n: p.discoveredFacets.unfilled })}
              {' · '}
              {t('console.preFilterWithText', {
                yes: p.discoveredFacets.with_text,
                no: p.discoveredFacets.without_text,
              })}
            </span>
          )}
        </div>

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
                pick={pick(item)}
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
                pick={pick(item)}
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
      {/* key 变化即重建内部 state：每次打开都是干净的编排（合集 0.34
          踩过「两个 effect 互相覆盖」的坑，见 CompilationModal 注释） */}
      <CompilationModal
        key={compilationOpen ? 'open' : 'closed'}
        open={compilationOpen}
        onClose={() => setCompilationOpen(false)}
      />
    </div>
  )
}
