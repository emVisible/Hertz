import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

import { TabBar } from '../../components/ui'
import { useStudioExecution } from '../../hooks/useStudioExecution'
import { usePipelineExecution } from '../../hooks/usePipelineExecution'
import { useModelSwitch } from '../../hooks/useModelSwitch'
import { StudioView } from './StudioView'
import { PipelineView } from './PipelineView'
import { MonolinePage } from '../monoline/MonolinePage'

type Mode = 'studio' | 'pipeline' | 'monoline'

/** 执行工作台：第二级路由（Studio / Pipeline / 文稿成片切换）+ 组装。
 *  Studio 域与 Pipeline 域分别位于 StudioView.tsx / PipelineView.tsx（解耦）；
 *  文稿成片为独立融合域（pages/monoline/），在此仅挂载为第三 tab。
 *  发布队列（v0.12）与内容日历（v0.2.3）在 v0.34 B 一并撤下界面，其职能由流水线
 *  第一级的「看板」tab 承载（`queue_phase` / `scheduled_at` 字段与后端机制都保留）。 */
export function ExecutionPage() {
  const { t } = useTranslation()
  const [params, setParams] = useSearchParams()
  const [mode, setModeState] = useState<Mode>(() => {
    const m = params.get('mode')
    if (m === 'pipeline' || m === 'monoline') return m
    return 'studio'
  })

  const studio = useStudioExecution()
  const pipeline = usePipelineExecution()
  const modelSwitch = useModelSwitch()

  function setMode(m: Mode) {
    setModeState(m)
    setParams(m === 'studio' ? {} : { mode: m }, { replace: true })
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-hidden p-4">
      {/* 模式切换（第二级路由）：TabBar 统一语言 */}
      <div className="shrink-0 border-b border-border">
        <TabBar
          items={[
            { id: 'studio', label: t('execution.modeStudio') },
            { id: 'pipeline', label: t('execution.modePipeline') },
            { id: 'monoline', label: t('nav.monoline') },
          ]}
          active={mode}
          onChange={setMode}
        />
      </div>

      {mode === 'monoline' ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <MonolinePage />
        </div>
      ) : mode === 'studio' ? (
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
          limit={pipeline.limit}
          setLimit={pipeline.setLimit}
          running={pipeline.running}
          statusJob={pipeline.status?.job ?? ''}
          counts={pipeline.counts}
          stageError={pipeline.stageError}
          refetchStage={pipeline.refetchStage}
          preFilters={pipeline.preFilters}
          discoveredFacets={pipeline.discoveredFacets}
          setPreFilters={pipeline.setPreFilters}
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
          sources={pipeline.sources}
          failures={pipeline.failures}
          publishStatus={pipeline.publishStatus}
          autoCollectMinutes={pipeline.autoCollectMinutes}
          collectStatus={pipeline.collectStatus}
          collectProgress={pipeline.collectProgress}
          stop={pipeline.stop}
          act={pipeline.act}
          setFocus={pipeline.setFocus}
          saveMeta={pipeline.saveMeta}
          publishItem={pipeline.publishItem}
          setPublishStats={pipeline.setPublishStats}
          uploadCover={pipeline.uploadCover}
          randomCover={pipeline.randomCover}
          retryClass={pipeline.retryClass}
          backToPrep={pipeline.backToPrep}
          batchAction={pipeline.batchAction}
          rescheduleExpired={pipeline.rescheduleExpired}
          setProduceOptions={pipeline.setProduceOptions}
          archivedItems={pipeline.archivedItems}
          invalidItems={pipeline.invalidItems}
          archiveItems={pipeline.archiveItems}
          unarchiveItems={pipeline.unarchiveItems}
          purgeItems={pipeline.purgeItems}
          produceOne={pipeline.produceOne}
          cancelProduceOne={pipeline.cancelProduceOne}
          produceBatch={pipeline.produceBatch}
          scoreOne={pipeline.scoreOne}
          scoreBatch={pipeline.scoreBatch}
          downloadBatchUnscored={pipeline.downloadBatchUnscored}
          downloadOne={pipeline.downloadOne}
          downloadOneDirect={pipeline.downloadOneDirect}
          busy={pipeline.busy}
          runStep={pipeline.runStep}
        />
      )}
    </div>
  )
}
