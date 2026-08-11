import { useTranslation } from 'react-i18next'

import { Button, Card, Icon, Input, MarkdownEditor } from '../../components/ui'

/** 策略编辑器（v0.8 拆分自 PlansPage）：名称 + Markdown 双栏内容。 */
export function BriefEditor({
  name,
  content,
  dirty,
  onName,
  onContent,
  onSave,
}: {
  name: string
  content: string
  dirty: boolean
  onName: (v: string) => void
  onContent: (v: string) => void
  onSave: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="flex w-full flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <Input
          label={t('briefs.name')}
          value={name}
          onChange={(e) => onName(e.target.value)}
          className="w-64"
        />
        <Button onClick={onSave} disabled={!dirty}>
          <Icon name="check" size={14} />
          {t('briefs.save')}
        </Button>
      </div>
      <Card padded={false} className="flex min-h-0 flex-1 flex-col">
        <MarkdownEditor
          value={content}
          onChange={onContent}
          placeholder={t('briefs.placeholder')}
        />
      </Card>
    </div>
  )
}
