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
  /** 运行时 buff 选择（v5.0）；空数组 = 跟随计划配置 */
  buffKeys: string[]
}

export interface PipelineExecState {
  step: string
  limit: number
  logs: LogLine[]
  logSeq: number
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
    buffKeys: [],
  },
  pipeline: {
    step: 'chain',
    limit: 10,
    logs: [],
    logSeq: 0,
  },
  setStudio: (patch) => set((s) => ({ studio: { ...s.studio, ...patch } })),
  setPipeline: (patch) => set((s) => ({ pipeline: { ...s.pipeline, ...patch } })),
  resetStudioLogs: () =>
    set((s) => ({ studio: { ...s.studio, logs: [], logSeq: 0, phaseStates: {} } })),
  resetPipelineLogs: () => set((s) => ({ pipeline: { ...s.pipeline, logs: [], logSeq: 0 } })),
}))
