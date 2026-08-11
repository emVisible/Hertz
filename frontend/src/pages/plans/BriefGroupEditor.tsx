import { useTranslation } from 'react-i18next'

import type { Brief } from '../../api'
import { Button, Card, Icon, Input } from '../../components/ui'

/** 策略组编辑器（v0.8 拆分自 PlansPage）：名称/说明 + 策略多选（顺序即注入顺序）。 */
export function BriefGroupEditor({
  name,
  description,
  briefIds,
  briefs,
  dirty,
  onName,
  onDescription,
  onToggleBrief,
  onSave,
}: {
  name: string
  description: string
  briefIds: string[]
  briefs: Brief[]
  dirty: boolean
  onName: (v: string) => void
  onDescription: (v: string) => void
  onToggleBrief: (id: string) => void
  onSave: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="flex w-full flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <Input
          label={t('briefGroups.name')}
          value={name}
          onChange={(e) => onName(e.target.value)}
          className="w-64"
        />
        <Button onClick={onSave} disabled={!dirty}>
          <Icon name="check" size={14} />
          {t('briefs.save')}
        </Button>
      </div>
      <Input
        label={t('briefGroups.description')}
        value={description}
        onChange={(e) => onDescription(e.target.value)}
        placeholder={t('briefGroups.descriptionHint')}
      />
      <Card padded={false} className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <h2 className="text-sm font-semibold">{t('briefGroups.members')}</h2>
          <span className="text-xs text-text-disabled">
            {t('briefGroups.membersHint', { n: briefIds.length })}
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5 p-3">
          {briefs.length === 0 && <p className="text-xs text-text-disabled">{t('briefs.empty')}</p>}
          {briefs.map((brief) => {
            const active = briefIds.includes(brief.id)
            return (
              <button
                key={brief.id}
                type="button"
                onClick={() => onToggleBrief(brief.id)}
                className={`border px-2 py-1 text-xs transition-colors ${
                  active
                    ? 'border-primary bg-primary/10 text-text-primary'
                    : 'border-border text-text-secondary hover:border-primary hover:text-primary'
                }`}
              >
                {brief.name}
              </button>
            )
          })}
        </div>
      </Card>
      <p className="text-[10px] leading-relaxed text-text-disabled">
        {t('briefGroups.priorityHint')}
      </p>
    </div>
  )
}
