/** Monoline 融合域：执行页第三 tab（/execution?mode=monoline）。新建 / 大纲 / 作业 / 模式库 / 设置。 */

import { useTranslation } from 'react-i18next'

import { TabBar } from '../../components/ui'
import { useExecutionStore, type MonolineExecState } from '../../stores/execution'
import { JobsTab } from './JobsTab'
import { ModesTab } from './ModesTab'
import { NewTab } from './NewTab'
import { OutlineTab } from './OutlineTab'
import { SetupTab } from './SetupTab'

type MonoTab = MonolineExecState['tab']

export function MonolinePage() {
  const { t } = useTranslation()
  const tab = useExecutionStore((s) => s.monoline.tab)
  const jobId = useExecutionStore((s) => s.monoline.jobId)
  const setMonoline = useExecutionStore((s) => s.setMonoline)

  const openOutline = (id: string) => {
    setMonoline({ jobId: id, tab: 'outline' })
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <TabBar<MonoTab>
        active={tab}
        onChange={(id) => setMonoline({ tab: id })}
        items={[
          { id: 'new', label: t('monoline.tabNew') },
          { id: 'outline', label: t('monoline.tabOutline') },
          { id: 'jobs', label: t('monoline.tabJobs') },
          { id: 'modes', label: t('monoline.tabModes') },
          { id: 'setup', label: t('monoline.tabSetup') },
        ]}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'new' && <NewTab onCreated={openOutline} />}
        {tab === 'outline' && <OutlineTab jobId={jobId} onPickJob={() => setMonoline({ tab: 'jobs' })} />}
        {tab === 'jobs' && <JobsTab selectedId={jobId} onSelect={(id) => setMonoline({ jobId: id })} />}
        {tab === 'modes' && <ModesTab />}
        {tab === 'setup' && <SetupTab />}
      </div>
    </div>
  )
}
