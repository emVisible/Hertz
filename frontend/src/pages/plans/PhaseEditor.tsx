import { useTranslation } from 'react-i18next'

import type { PhaseDef } from '../../api'
import { Badge, Button, Card, Icon, Input, Select } from '../../components/ui'
import { modelOptions, retryOptions, timeoutOptions } from '../../constants/llm'

/** 工序编辑器（v0.8 拆分自 PlansPage）：基本信息 + agent 配置（含参考素材文件）。 */
export function PhaseEditor({
  phase,
  name,
  description,
  role,
  method,
  style,
  model,
  retries,
  timeout,
  reference,
  dirty,
  onName,
  onDescription,
  onRole,
  onMethod,
  onStyle,
  onModel,
  onRetries,
  onTimeout,
  onReference,
  onSave,
}: {
  phase: PhaseDef | null
  name: string
  description: string
  role: string
  method: string
  style: string
  model: string
  retries: number
  timeout: number
  reference: string
  dirty: boolean
  onName: (v: string) => void
  onDescription: (v: string) => void
  onRole: (v: string) => void
  onMethod: (v: string) => void
  onStyle: (v: string) => void
  onModel: (v: string) => void
  onRetries: (v: number) => void
  onTimeout: (v: number) => void
  onReference: (v: string) => void
  onSave: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="flex w-full flex-col gap-3">
      <div className="flex items-end gap-3">
        <Input
          label={t('phases.name')}
          value={name}
          onChange={(e) => onName(e.target.value)}
          className="w-64"
        />
        {phase?.builtin ? <Badge tone="neutral">{t('phases.builtin')}</Badge> : null}
        <Button onClick={onSave} disabled={!dirty}>
          <Icon name="check" size={14} />
          {t('phases.save')}
        </Button>
      </div>
      <Card padded={false}>
        <div className="border-b border-border px-3 py-2">
          <h2 className="text-sm font-semibold">{t('phases.info')}</h2>
        </div>
        <dl className="grid grid-cols-1 gap-1 p-3 text-xs sm:grid-cols-2">
          <div className="flex gap-2">
            <dt className="w-20 text-text-disabled">{t('phases.key')}</dt>
            <dd className="font-mono text-text-primary">{phase?.key}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-20 text-text-disabled">{t('phases.type')}</dt>
            <dd className="text-text-primary">{phase?.phase_type ?? phase?.type ?? 'agent'}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-20 text-text-disabled">{t('phases.output')}</dt>
            <dd className="font-mono text-text-primary">
              {phase?.output_file || (phase?.key ? `${phase.key}.md` : '')}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-20 text-text-disabled">{t('phases.phaseGroup')}</dt>
            <dd className="text-text-primary">{phase?.phase_group ?? 'custom'}</dd>
          </div>
        </dl>
      </Card>
      <Input
        label={t('phases.description')}
        value={description}
        onChange={(e) => onDescription(e.target.value)}
        placeholder={t('phases.descHint')}
      />
      {(phase?.phase_type === 'agent' || phase?.type === 'agent') && (
        <Card padded={false} className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <h2 className="text-sm font-semibold">{t('phases.agentConfig')}</h2>
            <span className="text-xs text-text-disabled">{t('phases.agentHint')}</span>
          </div>
          <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-1 gap-3 p-3 md:grid-cols-2">
            <Input
              label={t('phases.role')}
              value={role}
              onChange={(e) => onRole(e.target.value)}
              placeholder={t('phases.roleHint')}
            />
            <Select
              label={t('phases.model')}
              value={model}
              onChange={(e) => onModel(e.target.value)}
              options={[{ value: '', label: t('phases.modelDefault') }, ...modelOptions(model)]}
            />
            <div className="md:col-span-2">
              <label className="mb-1 block text-xs font-medium text-text-secondary">
                {t('phases.method')}
                <span className="ml-2 text-text-disabled">{t('phases.methodHint')}</span>
              </label>
              <textarea
                value={method}
                onChange={(e) => onMethod(e.target.value)}
                spellCheck={false}
                rows={8}
                className="w-full resize-y border border-border bg-surface-2/60 px-3 py-2 font-mono text-sm leading-relaxed text-text-primary outline-none placeholder:text-text-disabled focus:border-primary"
                placeholder={t('phases.methodHint')}
              />
            </div>
            <Input
              label={t('phases.style')}
              value={style}
              onChange={(e) => onStyle(e.target.value)}
              placeholder={t('phases.styleHint')}
            />
            <div className="flex items-end gap-3">
              <Select
                label={t('phases.retries')}
                value={String(retries)}
                onChange={(e) => onRetries(Number(e.target.value) || 0)}
                className="w-24"
                options={retryOptions(retries)}
              />
              <Select
                label={t('phases.timeout')}
                value={String(timeout)}
                onChange={(e) => onTimeout(Number(e.target.value) || 300)}
                className="w-28"
                options={timeoutOptions(timeout)}
              />
            </div>
            {/* 参考素材文件（v0.7.2）：相对 data_dir 路径，运行时注入 system prompt */}
            <div className="md:col-span-2">
              <Input
                label={t('phases.reference')}
                value={reference}
                onChange={(e) => onReference(e.target.value)}
                placeholder="reference/33-anti-ai-rules.md"
              />
              <p className="mt-1 text-[10px] leading-relaxed text-text-disabled">
                {t('phases.referenceHint')}
              </p>
            </div>
          </div>
        </Card>
      )}
    </div>
  )
}
