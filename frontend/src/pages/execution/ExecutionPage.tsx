import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

import { TabBar } from '../../components/ui'
import { useStudioExecution } from '../../hooks/useStudioExecution'
import { usePipelineExecution } from '../../hooks/usePipelineExecution'
import { useModelSwitch } from '../../hooks/useModelSwitch'
import { StudioView } from './StudioView'
import { PipelineView } from './PipelineView'

type Mode = 'studio' | 'pipeline'

/** 执行工作台：第二级路由（Studio / Pipeline 切换）+ 组装。
 *  Studio 域与 Pipeline 域分别位于 StudioView.tsx / PipelineView.tsx（解耦）。 */
export function ExecutionPage() {
  const { t } = useTranslation()
  const [params, setParams] = useSearchParams()
  const [mode, setModeState] = useState<Mode>(() => (params.get('mode') === 'pipeline' ? 'pipeline' : 'studio'))

  const studio = useStudioExecution()
  const pipeline = usePipelineExecution()
  const modelSwitch = useModelSwitch()
  // 流水线运行时默认 AI（评分角色 fast，v0.2.0）
  const pipelineModelSwitch = useModelSwitch('fast')

  function setMode(m: Mode) {
    setModeState(m)
    setParams(m === 'pipeline' ? { mode: 'pipeline' } : {}, { replace: true })
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-hidden p-4">
      {/* 模式切换（第二级路由）：TabBar 统一语言 */}
      <div className="shrink-0 border-b border-border">
        <TabBar
          items={[
            { id: 'studio', label: t('execution.modeStudio') },
            { id: 'pipeline', label: t('execution.modePipeline') },
          ]}
          active={mode}
          onChange={setMode}
        />
      </div>

      {mode === 'studio' ? (
        <StudioView
          plans={studio.plans}
          planId={studio.planId}
          setPlanId={studio.setPlanId}
          topic={studio.topic}
          setTopic={studio.setTopic}
          running={studio.running}
          logs={studio.logs}
          phaseStates={studio.phaseStates}
          runs={studio.runs}
          runningPhase={studio.runningPhase}
          planPhases={studio.planPhases}
          selectedRun={studio.selectedRun}
          activeFile={studio.activeFile}
          setActiveFile={studio.setActiveFile}
          fileContent={studio.fileContent}
          statusText={studio.statusText}
          phaseName={studio.phaseName}
          run={studio.run}
          stop={studio.stop}
          selectRun={studio.selectRun}
          refreshFile={studio.refreshFile}
          modelSwitch={modelSwitch}
          runDetail={studio.runDetail}
          buffs={studio.buffs}
          buffKeys={studio.buffKeys}
          setBuffKeys={studio.setBuffKeys}
          depth={studio.depth}
          setDepth={studio.setDepth}
          depthLevels={studio.depthLevels}
        />
      ) : (
        <PipelineView
          step={pipeline.step}
          setStep={pipeline.setStep}
          limit={pipeline.limit}
          setLimit={pipeline.setLimit}
          steps={pipeline.steps}
          running={pipeline.running}
          statusJob={pipeline.status?.job ?? ''}
          counts={pipeline.counts}
          stageError={pipeline.stageError}
          refetchStage={pipeline.refetchStage}
          stageDiscovered={pipeline.stageDiscovered}
          stageDownloaded={pipeline.stageDownloaded}
          stageScored={pipeline.stageScored}
          stageQueued={pipeline.stageQueued}
          stageApproved={pipeline.stageApproved}
          stageFailed={pipeline.stageFailed}
          stageRejected={pipeline.stageRejected}
          stagePublished={pipeline.stagePublished}
          tab={pipeline.tab}
          setTab={pipeline.setTab}
          jobs={pipeline.jobs}
          sources={pipeline.sources}
          failures={pipeline.failures}
          supplyWarnings={pipeline.supplyWarnings}
          publishStatus={pipeline.publishStatus}
          logs={pipeline.logs}
          run={pipeline.run}
          stop={pipeline.stop}
          act={pipeline.act}
          saveMeta={pipeline.saveMeta}
          publishItem={pipeline.publishItem}
          uploadCover={pipeline.uploadCover}
          retryClass={pipeline.retryClass}
          backToPrep={pipeline.backToPrep}
          backToCollect={pipeline.backToCollect}
          batchAction={pipeline.batchAction}
          rescheduleExpired={pipeline.rescheduleExpired}
          setProduceOptions={pipeline.setProduceOptions}
          produceOne={pipeline.produceOne}
          produceBatch={pipeline.produceBatch}
          collectAndDownload={pipeline.collectAndDownload}
          scoreOne={pipeline.scoreOne}
          scoreBatch={pipeline.scoreBatch}
          runStep={pipeline.runStep}
          modelSwitch={pipelineModelSwitch}
        />
      )}
    </div>
  )
}
