/** 看板需要的动作面（v0.34 看板重设计）。
 *
 * 为什么不直接用流水线主壳那一整包 `PipelineViewProps`：看板搬到顶级页之后，主壳那些
 * 字段（`statusJob` / `limit` / 各排序 state / 批量选择…）这里根本拿不到，为了过类型去
 * 编一份假值比直接声明需求糟得多。
 * 用 `Pick<ReturnType<typeof usePipelineExecution>, …>` 而不是手抄签名：签名跟着 hook 走，
 * 参数改了会立刻在这里报错，不会悄悄漂成两套。
 */

import type { usePipelineExecution } from '../../hooks/usePipelineExecution'

type PipelineBus = ReturnType<typeof usePipelineExecution>

export type BoardActions = Pick<
  PipelineBus,
  | 'publishStatus'
  | 'act'
  | 'setFocus'
  | 'saveMeta'
  | 'publishItem'
  | 'randomCover'
  | 'uploadCover'
  | 'backToPrep'
  | 'setPublishStats'
>
