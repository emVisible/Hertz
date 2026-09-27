/** Monoline 融合域：一级菜单页（/monoline）。新建 / 大纲 / 作业 / 模式库 / 设置。 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { TabBar } from '../../components/ui'
import { JobsTab } from './JobsTab'
import { ModesTab } from './ModesTab'
import { NewTab } from './NewTab'
import { OutlineTab } from './OutlineTab'
import { SetupTab } from './SetupTab'

type MonoTab = 'new' | 'outline' | 'jobs' | 'modes' | 'setup'

export function MonolinePage() {
  const { t } = useTranslation()
  const [tab, setTab] = useState<MonoTab>('new')
  const [jobId, setJobId] = useState<string | null>(null)

  const openOutline = (id: string) => {
    setJobId(id)
    setTab('outline')
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4">
      <TabBar<MonoTab>
        active={tab}
        onChange={setTab}
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
        {tab === 'outline' && <OutlineTab jobId={jobId} onPickJob={() => setTab('jobs')} />}
        {tab === 'jobs' && <JobsTab selectedId={jobId} onSelect={setJobId} />}
        {tab === 'modes' && <ModesTab />}
        {tab === 'setup' && <SetupTab />}
      </div>
    </div>
  )
}
