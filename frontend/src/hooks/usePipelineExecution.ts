import { usePipelineData } from './usePipelineData'
import { usePipelineEvents } from './usePipelineEvents'
import { usePipelineActions } from './usePipelineActions'

export { chunkIds } from './usePipelineActions'

/** Pipeline 域执行状态（从 ConsolePage 抽取，逻辑零改动）。
 *  v0.23：拆为三个独立 hooks——数据 / 事件 / 操作。 */
export function usePipelineExecution() {
  const data = usePipelineData()
  usePipelineEvents()
  const actions = usePipelineActions({
    discoveryAll: data.stageDiscovered,
    queueAll: [
      ...data.stageDownloaded,
      ...data.stageScored,
      ...data.stageQueued,
      ...data.stageApproved,
      ...data.stageFailed,
      ...data.stageRejected,
    ],
    stagePublished: data.stagePublished,
    limit: data.limit,
  })

  return {
    ...data,
    ...actions,
  }
}
