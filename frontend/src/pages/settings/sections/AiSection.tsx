/** Settings AI 区（v0.20 拆分）：功能映射 / 供应商 / 角色 / 单价·币种·预算 /
 *  频道人设 / 术语表。纯结构移动自 SettingsPage，零行为变化。 */

import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { api } from '../../../api'
import { aiRegistryApi, type AIProviderDTO } from '../../../api/ai'
import { Badge, Button, Icon, Input, Select, useToast } from '../../../components/ui'
import { ProviderManager } from '../ProviderManager'
import { RolesManager } from '../RolesManager'
import { FeaturesMap } from '../FeaturesMap'
import { GlossaryManager } from '../GlossaryManager'
import { heading, sub, type SectionProps } from './shared'

interface PricesConfig {
  ai_model_prices?: Record<string, { prompt?: number; completion?: number }>
  cost_currency?: string
  cost_usd_rate?: number
  cost_monthly_budget?: number
}

/** 模型单价配置（v0.5 E 成本估算）：每行 `model_key: prompt价/completion价`（美元/百万 tokens）。
 *  v0.14.1：报表币种 + 汇率随单价一并维护。 */
function ModelPrices() {
  const { t } = useTranslation()
  const toast = useToast()
  const { data: cfg, refetch } = useQuery({
    queryKey: ['config'],
    queryFn: () => api.get<PricesConfig>('/api/config'),
  })
  const [raw, setRaw] = useState('')
  const [currency, setCurrency] = useState('CNY')
  const [rate, setRate] = useState('7.2')
  const [budget, setBudget] = useState('0')

  useEffect(() => {
    if (!cfg) return
    const prices = (cfg.ai_model_prices ?? {}) as Record<
      string,
      { prompt?: number; completion?: number }
    >
    setRaw(
      Object.entries(prices)
        .map(([k, v]) => `${k}: ${v?.prompt ?? 0}/${v?.completion ?? 0}`)
        .join('\n'),
    )
    setCurrency(cfg.cost_currency ?? 'CNY')
    setRate(String(cfg.cost_usd_rate ?? 7.2))
    setBudget(String(cfg.cost_monthly_budget ?? 0))
  }, [cfg])

  async function save() {
    const prices: Record<string, { prompt: number; completion: number }> = {}
    for (const line of raw.split('\n')) {
      const m = line.trim().match(/^([^\s:]+):\s*([\d.]+)\s*\/\s*([\d.]+)$/)
      if (!m) continue
      prices[m[1]] = { prompt: Number(m[2]), completion: Number(m[3]) }
    }
    try {
      await api.patch('/api/config', {
        overrides: {
          ai_model_prices: prices,
          cost_currency: currency,
          cost_usd_rate: Number(rate) || 1,
          cost_monthly_budget: Number(budget) || 0,
        },
      })
      await refetch()
      toast(t('settings.saved'), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-text-secondary">{t('settings.pricesHint')}</p>
      <div className="grid grid-cols-2 gap-3">
        <Select
          label={t('settings.costCurrency')}
          value={currency}
          onChange={(e) => setCurrency(e.target.value)}
          options={[
            { value: 'CNY', label: t('settings.costCurrencyCny') },
            { value: 'USD', label: t('settings.costCurrencyUsd') },
          ]}
        />
        <Input
          label={t('settings.costUsdRate')}
          type="number"
          step="0.01"
          min={0}
          value={rate}
          onChange={(e) => setRate(e.target.value)}
        />
      </div>
      <Input
        label={t('settings.monthlyBudget')}
        type="number"
        step="1"
        min={0}
        value={budget}
        onChange={(e) => setBudget(e.target.value)}
      />
      <textarea
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        spellCheck={false}
        rows={4}
        placeholder={'deepseek-chat: 0.27/1.10'}
        className="w-full resize-y border border-border bg-surface-2/60 px-3 py-2 font-mono text-xs leading-relaxed text-text-primary outline-none placeholder:text-text-disabled focus:border-primary"
      />
      <Button size="sm" className="self-end" onClick={() => void save()}>
        <Icon name="check" size={13} />
        {t('common.save')}
      </Button>
    </div>
  )
}

export function AiSection({ form, set }: Pick<SectionProps, 'form' | 'set'>) {
  const { t } = useTranslation()
  const { data: providers = [] } = useQuery<AIProviderDTO[]>({
    queryKey: ['ai-providers'],
    queryFn: aiRegistryApi.listProviders,
  })

  return (
    <>
      {/* 功能 → 模型 总览（素材 AI 整理/翻译/评分都走 fast 池，配置点在下方） */}
      <section className="border border-border bg-surface-1/60 p-4">
        <div className="mb-2 flex items-center gap-2">
          <Icon name="layers" size={15} />
          <h2 className="text-sm font-semibold text-text-primary">{t('settings.features')}</h2>
        </div>
        <div className="mt-2">
          <FeaturesMap />
        </div>
      </section>

      <section className="border border-border bg-surface-1/60 p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className={heading}>
            <Icon name="studio" size={15} />
            {t('settings.llm')}
          </h2>
          <Badge tone={providers.some((p) => p.enabled) ? 'success' : 'neutral'}>
            {providers.some((p) => p.enabled)
              ? t('settings.configured')
              : t('settings.unconfigured')}
          </Badge>
        </div>
        <p className={sub}>{t('settings.llmHint')}</p>
        <ProviderManager />
      </section>

      <section className="border border-border bg-surface-1/60 p-4">
        <div className="mb-2 flex items-center gap-2">
          <Icon name="box" size={15} />
          <h2 className="text-sm font-semibold text-text-primary">{t('settings.models')}</h2>
        </div>
        <RolesManager />
      </section>

      <section className="border border-border bg-surface-1/60 p-4">
        <div className="mb-2 flex items-center gap-2">
          <Icon name="config" size={15} />
          <h2 className="text-sm font-semibold text-text-primary">{t('settings.prices')}</h2>
        </div>
        <ModelPrices />
      </section>

      {/* 频道人设记忆（v0.18）：注入脚本与标题 prompt */}
      <section className="border border-border bg-surface-1/60 p-4">
        <div className="mb-2 flex items-center gap-2">
          <Icon name="briefs" size={15} />
          <h2 className="text-sm font-semibold text-text-primary">{t('settings.persona')}</h2>
        </div>
        <textarea
          value={form.channel_persona ?? ''}
          onChange={(e) => set('channel_persona', e.target.value)}
          rows={4}
          placeholder={t('settings.personaPlaceholder')}
          className="w-full resize-y border border-border bg-surface-2/60 px-3 py-2 text-xs leading-relaxed text-text-primary outline-none placeholder:text-text-disabled focus:border-primary"
        />
        <p className="mt-2 text-xs leading-relaxed text-text-disabled">
          {t('settings.personaHint')}
        </p>
      </section>

      {/* 翻译术语表（v0.15）：术语统一——字幕质量地基 */}
      <section className="border border-border bg-surface-1/60 p-4">
        <div className="mb-2 flex items-center gap-2">
          <Icon name="pen" size={15} />
          <h2 className="text-sm font-semibold text-text-primary">{t('settings.glossary')}</h2>
        </div>
        <GlossaryManager />
      </section>
    </>
  )
}
