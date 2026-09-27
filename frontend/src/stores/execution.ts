import { create } from 'zustand'

import type { LogLine } from '../components/execution'

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

export interface PipelineExecState {
  step: string
  limit: number
  /** 流水线平铺菜单当前部分（wave13：跨模式切换保持上下文） */
  tab: string
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
    tab: 'inReview',
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
