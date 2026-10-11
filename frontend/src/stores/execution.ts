import { create } from 'zustand'

import type { LogLine } from '../components/execution'
import type {
  PreHasText,
  PreMaterial,
  PreQuality,
  PreTheme,
} from '../core/preReviewFilter'

/**
 * 执行工作台状态（Wave 7.0 缓存机制）：
 * 切换 tab / 离开页面再回来时，Studio/Pipeline 的进度、日志、参数
 * 全部保留——zustand store 独立于组件生命周期。
 */

export interface StudioExecState {
  planId: string
  topic: string
  running: boolean
  logs: LogLine[]
  phaseStates: Record<string, string>
  activeRunId: string | null
  activeFile: string
  fileContent: string
  logSeq: number
  /** 运行时 buff/debuff 选择（v5.0）。
   *  默认 = 随机应变（每次运行抽 3 个随机 buff）+ 禁用 AI 套话 debuff；
   *  用户取消全部选择后为空数组 = 跟随计划持久配置。 */
  buffKeys: string[]
  /** 输出深度档位（v0.3.10）：terse/concise/normal/detailed/deep，默认 normal */
  depth: string
}

/** 预处理页的次级分段（未评分 / 已评分未下载 / 已下载未加工）。
 *  类型与状态同在 store：看板的「去未评分筛素材」动线在**另一个页面**（顶级看板），
 *  它必须能同时设「分段 + 三轴 + tab」，所以这三件事得是同一个作者名下的状态。
 *  （放在 `PreReviewTab.tsx` 里就会变成「页面持有、跨页写不到」。） */
export type PreStage = 'discovered' | 'scored' | 'downloaded'

export interface PipelineExecState {
  step: string
  limit: number
  /** 流水线平铺菜单当前部分（wave13：跨模式切换保持上下文） */
  tab: string
  /** 预处理页的次级分段（v0.34：为跨页动线搬进 store，见 `PreStage` 注释） */
  preStage: PreStage
  /** 预处理页的筛选轴（v0.34 A）：与 tab/limit 同一作者——离开页面再回来要保住，
   *  且必须随请求发送（服务端筛）。默认四轴全是「全部」：**不**默认情感，
   *  否则用户第一次打开会以为数据变少了。 */
  preTheme: PreTheme
  preQuality: PreQuality
  preHasText: PreHasText
  /** 素材类型轴（图文 / 视频 / 文字帖）。三段共用同一个值——它是「在筛什么素材」，
   *  不是某一段的局部视图；分段换了选择仍在，所以它属于 store 而非页内 state。 */
  preMaterial: PreMaterial
  /** 采集进度（v0.8.2）：最近一次 collect 各源明细（可视化运维） */
  collectProgress: Array<{ channel: string; collected?: number; inserted?: number; cooldown_s?: number; error?: string }>
  /** 单条操作进行中（v0.11.3）：itemId → 操作信息——按钮转圈 + 防重复提交
   *  的数据源。v0.11.4：升级为 {action, title}——底部「运行状态」折叠条
   *  直接展示「制作中《标题》」，无需依赖页面内条目列表反查标题。 */
  busy: Record<string, { action: string; title: string }>
}

export interface MonolineExecState {
  /** 页内 tab：新建/大纲/作业/模式库/设置（跨执行 tab 切换保持） */
  tab: 'new' | 'outline' | 'jobs' | 'modes' | 'setup'
  /** 当前选中作业（跨切换保持，与 studio.activeRunId 对齐） */
  jobId: string | null
}

interface ExecutionState {
  studio: StudioExecState
  pipeline: PipelineExecState
  monoline: MonolineExecState
  setStudio: (patch: Partial<StudioExecState>) => void
  setPipeline: (patch: Partial<PipelineExecState>) => void
  setMonoline: (patch: Partial<MonolineExecState>) => void
  resetStudioLogs: () => void
}

export const useExecutionStore = create<ExecutionState>((set) => ({
  studio: {
    planId: '',
    topic: '',
    running: false,
    logs: [],
    phaseStates: {},
    activeRunId: null,
    activeFile: 'final.md',
    fileContent: '',
    logSeq: 0,
    buffKeys: ['random', 'no_ai_phrases'],
    depth: 'normal',
  },
  pipeline: {
    step: 'collect',
    limit: 10,
    // v0.34：看板搬到顶级菜单后，流水线自己默认开在「预处理」——那是每天真正
    // 动手的地方（未评分筛选 + 下载/评分/制作），而「今天要做什么」看顶级看板。
    tab: 'preReview',
    /** 分段默认「已下载未加工」（沿用 v0.8.8 以来的习惯：进页面先看能直接做的活） */
    preStage: 'downloaded',
    // v0.34 A：未评分区三轴默认「全部」——默认情感会让第一次打开像是数据变少了
    preTheme: 'all',
    preQuality: 'all',
    preHasText: 'all',
    preMaterial: 'all',
    collectProgress: [],
    busy: {},
  },
  monoline: {
    tab: 'new',
    jobId: null,
  },
  setStudio: (patch) => set((s) => ({ studio: { ...s.studio, ...patch } })),
  setPipeline: (patch) => set((s) => ({ pipeline: { ...s.pipeline, ...patch } })),
  setMonoline: (patch) => set((s) => ({ monoline: { ...s.monoline, ...patch } })),
  resetStudioLogs: () =>
    set((s) => ({ studio: { ...s.studio, logs: [], logSeq: 0, phaseStates: {} } })),
}))
