import { useMemo } from 'react'
import { useQuery, type Query } from '@tanstack/react-query'

import { api, pipelineApi, type PipelineItem } from '../api'
import type { PreHasText, PreQuality, PreReviewFilters, PreTheme } from '../core/preReviewFilter'
import { useExecutionStore } from '../stores/execution'

/** 三轴的写入形状：与 zustand pipeline 切片同名同键（不是 PreReviewFilters 的
 *  theme/quality/hasText——那是读模型/请求形状，两套名字之间不做映射层）。 */
export interface PreFilterPatch {
  preTheme?: PreTheme
  preQuality?: PreQuality
  preHasText?: PreHasText
}

// 轮询只是 SSE 的兜底：空闲时 15s 一次，流水线运行中 2s（AXIOM §7.2 性能预算）。
// v5 Query 回调需全泛型才兼容各 useQuery 具体类型
const pollingInterval = (
  query: Query<any, any, any, any>,
): number | false =>
  (query.state.data as { running?: boolean } | undefined)?.running
    ? 2000
    : 15000

/** Pipeline 域数据查询 + 派生状态。 */
export function usePipelineData() {
  // v0.34 A：store 提到最前——三轴的读模型要在第一个 useQuery 之前可用，
  // 而 queryKey 里引用 store 会撞「声明前使用」（tsc TS2448 抓到过）。
  const store = useExecutionStore()
  const { data: status } = useQuery({
    queryKey: ['pipeline-status'],
    queryFn: pipelineApi.status,
    refetchInterval: 5000,
  })
  const { data: counts = {} } = useQuery({
    queryKey: ['pipeline-counts'],
    queryFn: pipelineApi.counts,
    refetchInterval: pollingInterval,
  })
  // 阶段队列（v0.3.5）：发现队列独立查询——避免 discovered 占满 limit 截断
  // 已下载/已评分/待审核等旧序条目（seq desc 排序下老数据被 200 截断的 bug）
  // v0.34 A：三轴筛选**必须随请求发送**（服务端筛）。界面拉的是最新 500 条，
  // 而 discovered 活口实测 2659 条——客户端筛只能看见最新 500，一旦情感内容不在
  // 那 500 条里，界面就会得出「没有情感内容」的假结论。参数拼装唯一作者是
  // core/preReviewFilter，列表与分面共用它，谁也不许再拼一套。
  const preFilters: PreReviewFilters = {
    theme: store.pipeline.preTheme,
    quality: store.pipeline.preQuality,
    hasText: store.pipeline.preHasText,
  }
  const { data: discoveryAll = [], isError: stageError, refetch: refetchStage } = useQuery({
    queryKey: ['pipeline-stage', preFilters],
    // v0.3.12：349 条发现队列此前被 200 截断——提到 500
    queryFn: () => pipelineApi.items('discovered', 500, preFilters),
    refetchInterval: pollingInterval,
  })
  // 分面（v0.34 A）：total 是不加轴的全量分母、hit 是加满当前轴之后的数——
  // 两个数分开拿，界面才分得清「筛没了」和「本来就没有」。
  const { data: discoveredFacets } = useQuery({
    queryKey: ['pipeline-facets', preFilters],
    queryFn: () => pipelineApi.itemFacets('discovered', preFilters),
    refetchInterval: pollingInterval,
  })
  const { data: queueAll = [] } = useQuery({
    queryKey: ['pipeline-queue'],
    queryFn: () =>
      pipelineApi.items('downloaded,scored,queued,approved,failed,rejected', 500),
    refetchInterval: pollingInterval,
  })
  // 发布历史（v0.3.8）：已发布内容完整回到发布列表——不再只有最近 10 条
  const { data: stagePublished = [] } = useQuery({
    queryKey: ['pipeline-stage', 'published'],
    queryFn: () => pipelineApi.items('published', 100),
    refetchInterval: pollingInterval,
  })
  const stageGroups = useMemo(() => {
    const g: Record<string, PipelineItem[]> = {}
    for (const it of queueAll) {
      ;(g[it.status] ??= []).push(it)
    }
    return g
  }, [queueAll])
  const { data: sources = [] } = useQuery({
    queryKey: ['pipeline-sources'],
    queryFn: pipelineApi.sources,
  })
  // 失败分类看板（v0.2.1）：failed 按类聚合，同类批量重试
  const { data: failures = {} } = useQuery({
    queryKey: ['pipeline-failures'],
    queryFn: pipelineApi.failures,
    refetchInterval: pollingInterval,
  })
  // 供给告警（漏斗空 / 供给偏紧 / 采集源失联）
  const { data: supply = { warnings: [] } } = useQuery({
    queryKey: ['pipeline-supply'],
    queryFn: pipelineApi.supply,
    refetchInterval: pollingInterval,
  })
  // 发布健康状态（v0.3.8）：目标 + B 站 cookie 就绪度——noop 目标下发布仅记录意图
  const { data: publishStatus } = useQuery({
    queryKey: ['pipeline-publish-status'],
    queryFn: pipelineApi.publishStatus,
    refetchInterval: pollingInterval,
  })
  // 自动采集配置（v0.8.1）：间隔分钟（0=关闭）——采集 tab 状态徽章
  const { data: cfg } = useQuery({
    queryKey: ['config'],
    queryFn: () => api.get<{ pipeline_auto_collect_minutes?: number }>('/api/config'),
  })
  const autoCollectMinutes = cfg?.pipeline_auto_collect_minutes ?? 30
  // 采集运维状态（v0.8.2）：监视用
  const { data: collectStatus } = useQuery({
    queryKey: ['pipeline-collect-status'],
    queryFn: pipelineApi.collectStatus,
    refetchInterval: pollingInterval,
  })
  // 备用库（wave10）：归档条目——删除入口收口异常区
  const { data: archivedItems = [] } = useQuery({
    queryKey: ['pipeline-archived'],
    queryFn: () => pipelineApi.archivedItems(200),
    refetchInterval: pollingInterval,
  })
  // 空壳池（v0.33）：无媒体且无正文的条目已被隔离，只在异常区出现
  const { data: invalidItems = [] } = useQuery({
    queryKey: ['pipeline-invalid'],
    queryFn: () => pipelineApi.invalidItems(),
    refetchInterval: pollingInterval,
  })

  const { tab, limit, collectProgress, busy } = store.pipeline
  const setPipeline = store.setPipeline
  const running = (status as { running?: boolean } | undefined)?.running ?? false

  return {
    status,
    counts,
    busy,
    stageError,
    refetchStage,
    stageDiscovered: discoveryAll,
    // v0.34 A：当前轴与分面（total=全量分母 / hit=加轴后命中 / unfilled=缺值那一档）
    preFilters,
    discoveredFacets,
    /** 写三轴：入参形状**就是** store 切片的形状（preTheme/preQuality/preHasText），
     *  不做名字映射——多一层映射就多一个「收下了形参却没用」的静默失效面。
     *  读模型 preFilters 由上面三格派生，二者同源。 */
    setPreFilters: (patch: PreFilterPatch) => setPipeline(patch),
    stageDownloaded: stageGroups.downloaded ?? [],
    stageScored: stageGroups.scored ?? [],
    stageQueued: stageGroups.queued ?? [],
    stageApproved: stageGroups.approved ?? [],
    stageFailed: stageGroups.failed ?? [],
    stageRejected: stageGroups.rejected ?? [],
    stagePublished,
    tab,
    setTab: (v: string) => setPipeline({ tab: v }),
    sources,
    failures,
    supplyWarnings: supply.warnings,
    limit,
    setLimit: (v: number) => setPipeline({ limit: v }),
    running,
    publishStatus,
    autoCollectMinutes,
    collectStatus,
    collectProgress,
    archivedItems,
    invalidItems,
    setPipeline,
  }
}
