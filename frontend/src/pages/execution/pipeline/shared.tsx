/** Pipeline 五 tab 共享件（v0.20 拆分）：PipelineViewProps 契约 + tab 常量。
 *  「state 留壳、JSX 下放」（D-183）——collectProgress 等是 hook useState 非 zustand，
 *  tab 组件不自治取数，全部经主壳 props 下发，避免与 ActivityPanel 状态分裂。 */

import type { PipelineItem } from '../../../api'
import type { PreFilterPatch } from '../../../hooks/usePipelineData'
import type { usePipelineExecution } from '../../../hooks/usePipelineExecution'

export interface PipelineViewProps {
  limit: number
  setLimit: (v: number) => void
  running: boolean
  statusJob: string
  counts: Record<string, number>
  stageError: boolean
  refetchStage: () => void
  stageDiscovered: ReturnType<typeof usePipelineExecution>['stageDiscovered']
  /** 未评分三轴（v0.34 A）：读模型 + 分面 + 写轴入口。
   *  轴必须进请求（服务端筛：limit 500 < discovered 活口 2659），
   *  分面的 total/hit 是两个数——界面才分得清「筛没了」与「本来就没有」。 */
  preFilters: ReturnType<typeof usePipelineExecution>['preFilters']
  discoveredFacets?: ReturnType<typeof usePipelineExecution>['discoveredFacets']
  setPreFilters: (patch: PreFilterPatch) => void
  stageDownloaded: ReturnType<typeof usePipelineExecution>['stageDownloaded']
  stageScored: ReturnType<typeof usePipelineExecution>['stageScored']
  stageQueued: ReturnType<typeof usePipelineExecution>['stageQueued']
  stageApproved: ReturnType<typeof usePipelineExecution>['stageApproved']
  stageFailed: ReturnType<typeof usePipelineExecution>['stageFailed']
  stageRejected: ReturnType<typeof usePipelineExecution>['stageRejected']
  stagePublished: ReturnType<typeof usePipelineExecution>['stagePublished']
  tab: string
  setTab: (v: string) => void
  sources: ReturnType<typeof usePipelineExecution>['sources']
  failures: Record<string, number>
  publishStatus?: ReturnType<typeof usePipelineExecution>['publishStatus']
  autoCollectMinutes: number
  collectStatus?: ReturnType<typeof usePipelineExecution>['collectStatus']
  stop: () => void
  collectProgress: ReturnType<typeof usePipelineExecution>['collectProgress']
  act: (item: PipelineItem, action: 'approve' | 'reject' | 'retry' | 'requeue' | 'retranslate') => void
  saveMeta: (item: PipelineItem, meta: Record<string, string | number | null>) => Promise<void>
  publishItem: (item: PipelineItem, selfmade?: boolean, target?: string, now?: boolean) => void
  setPublishStats: (item: PipelineItem) => void
  uploadCover: (item: PipelineItem, file: File) => void
  randomCover: (item: PipelineItem) => void
  // v0.34 B：发布队列的界面写点（`enqueueItem`）随「入队」按钮退役——
  // `queue_phase` 字段与后端 `POST /items/{id}/queue` 都还在，只是界面上喂不进去。
  retryClass: (cls: string, n: number) => void
  backToPrep: (item: PipelineItem) => void
  batchAction: (action: 'approve' | 'reject' | 'back_to_prep' | 'requeue', ids: string[]) => void
  rescheduleExpired: () => Promise<void>
  setProduceOptions: (items: PipelineItem[], options: Record<string, boolean>) => Promise<void>
  /** 备用库（wave10）：归档条目 + 归档/恢复/彻底删除 */
  archivedItems: ReturnType<typeof usePipelineExecution>['archivedItems']
  /** 空壳池（v0.33）：被隔离的无媒体无正文条目（含隔离原因 error 文本） */
  invalidItems: PipelineItem[]
  archiveItems: (items: PipelineItem[]) => Promise<void>
  unarchiveItems: (items: PipelineItem[]) => Promise<void>
  purgeItems: (items: PipelineItem[]) => Promise<void>
  produceOne: (item: PipelineItem) => Promise<void>
  /** 取消制作（wave11）：制作中按钮切换为取消入口 */
  cancelProduceOne: (item: PipelineItem) => Promise<void>
  produceBatch: () => Promise<void>
  scoreOne: (item: PipelineItem) => Promise<void>
  scoreBatch: () => Promise<void>
  /** 批量直下（v0.11.10）：未评分条目绕过评分直接下载 */
  downloadBatchUnscored: () => Promise<void>
  downloadOne: (item: PipelineItem) => Promise<void>
  /** 单条直下（v0.11.10）：discovered 行的宽松下载入口 */
  downloadOneDirect: (item: PipelineItem) => Promise<void>
  runStep: (stepName: string, channel?: string) => Promise<void>
  /** 单条操作进行中（v0.11.4）：itemId → {action, title}——按钮转圈数据源；
   *  全局展示已移交底部「运行状态」折叠条（ActivityPanel） */
  busy: Record<string, { action: string; title: string }>
}

export type PipelineTabId = 'run' | 'workshop' | 'preReview' | 'inReview' | 'exceptions'

// 第三级路由：内容流水线平铺菜单（v0.2.0 审核三态）——
// v0.8.4：采集（scheduler 自动 + 手动触发，只入 DB）｜预处理（下载/评分/生产方式/制作）
// ｜审核（内容判断）｜发布（分发）｜异常（独立恢复区）
// v0.34 B：看板**替换发布**（当时 6→6）。同日用户纠正了他说的「看板」指哪一页——
// 是**顶级菜单**那个进软件默认落到的看板（`/dashboard`），不是流水线的子菜单。
// 于是 board 整体搬去顶级页（`pages/dashboard/BoardTab.tsx`），流水线回到 5 个子 tab；
// 发布动作跟着走（「待发布」列在顶级看板上，复用的还是同一批 `PublishCard`）。
// 取舍与否决方案记在 `docs/SPEC_V034_BOARD.md` §4.4b/§4.4c 与 D-216。
// 异常区仍留在 exceptions，看板不承载（§二 非目标不变）。
export const PIPELINE_TABS = [
  { id: 'run', labelKey: 'console.stageCollect' },
  { id: 'workshop', labelKey: 'console.workshop' },
  { id: 'preReview', labelKey: 'console.stagePreReview', countKeys: ['discovered', 'downloaded', 'scored'] },
  { id: 'inReview', labelKey: 'console.stageAudit', countKeys: ['queued'] },
  { id: 'exceptions', labelKey: 'console.stageExceptions', countKeys: ['failed', 'rejected'] },
] satisfies Array<{
  id: PipelineTabId
  labelKey: string
  countKeys?: string[]
}>
