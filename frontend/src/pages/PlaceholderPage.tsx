import { useTranslation } from 'react-i18next'

import { EmptyState, type IconName } from '../components/ui'

export interface PlaceholderPageProps {
  icon?: IconName
}

export function PlaceholderPage({ icon }: PlaceholderPageProps) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-1 items-center justify-center">
      <EmptyState
        icon={icon}
        title={t('placeholder.title')}
        description={t('placeholder.description')}
      />
    </div>
  )
}
