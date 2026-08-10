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
  logs: LogLine[]
  logSeq: number
  /** 流水线平铺菜单当前部分（wave13：跨模式切换保持上下文） */
  tab: string
}

interface ExecutionState {
  studio: StudioExecState
  pipeline: PipelineExecState
  setStudio: (patch: Partial<StudioExecState>) => void
  setPipeline: (patch: Partial<PipelineExecState>) => void
  resetStudioLogs: () => void
  resetPipelineLogs: () => void
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
    logs: [],
    logSeq: 0,
    tab: 'inReview',
  },
  setStudio: (patch) => set((s) => ({ studio: { ...s.studio, ...patch } })),
  setPipeline: (patch) => set((s) => ({ pipeline: { ...s.pipeline, ...patch } })),
  resetStudioLogs: () =>
    set((s) => ({ studio: { ...s.studio, logs: [], logSeq: 0, phaseStates: {} } })),
  resetPipelineLogs: () => set((s) => ({ pipeline: { ...s.pipeline, logs: [], logSeq: 0 } })),
}))
