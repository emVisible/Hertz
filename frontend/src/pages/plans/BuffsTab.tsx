import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'

import { buffsApi } from '../../api'
import { Badge, Button, Card, EmptyState, Icon, Input, Select, useToast } from '../../components/ui'

/**
 * Buff 库（v5.0）：游戏化态度/话术注入指令。
 * lightweight（轻量）= 简单一句话/一段话注入；heavy（重量）= 类 skill 的复杂指令。
 * 左侧分组列表（稳定池/随机池），右侧编辑（名称/类型/类别 + MD 效果双栏）。
 * 受控组件：selectedId/onSelect 由 PlansPage 左侧列表驱动。
 */
export function BuffsTab({
  selectedId,
  onSelect,
  polarity,
}: {
  selectedId: string | null
  onSelect: (id: string | null) => void
  /** buff（正向）| debuff（反向禁忌）——v5.2 */
  polarity: 'buff' | 'debuff'
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const queryClient = useQueryClient()
  const { data: buffs = [] } = useQuery({ queryKey: ['buffs'], queryFn: buffsApi.list })

  const [name, setName] = useState('')
  const [kind, setKind] = useState<'lightweight' | 'heavy'>('lightweight')
  const [category, setCategory] = useState<'stable' | 'random'>('stable')
  const [effect, setEffect] = useState('')
  const [dirty, setDirty] = useState(false)

  const selected = buffs.find((b) => b.id === selectedId && b.polarity === polarity) ?? null

  useEffect(() => {
    if (!selected) return
    setName(selected.name)
    setKind(selected.kind)
    setCategory(selected.category)
    setEffect(selected.effect)
    setDirty(false)
  }, [selectedId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    if (!selectedId) return
    try {
      const buff = await buffsApi.update(selectedId, { name, kind, category, effect, polarity })
      await queryClient.invalidateQueries({ queryKey: ['buffs'] })
      onSelect(buff.id)
      toast(t('buffs.saved'), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const stable = buffs.filter((b) => b.category === 'stable' && b.polarity === polarity)

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col gap-3">
      {!selected ? (
        <EmptyState
          icon="wand"
          title={polarity === 'debuff' ? t('buffs.debuffSelect') : t('buffs.select')}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <Input
              label={t('buffs.name')}
              value={name}
              onChange={(e) => { setName(e.target.value); setDirty(true) }}
              className="w-48"
            />
            <Select
              label={t('buffs.kind')}
              value={kind}
              onChange={(e) => { setKind(e.target.value as 'lightweight' | 'heavy'); setDirty(true) }}
              options={[
                { value: 'lightweight', label: t('buffs.kindLight') },
                { value: 'heavy', label: t('buffs.kindHeavy') },
              ]}
            />
            <Select
              label={t('buffs.category')}
              value={category}
              onChange={(e) => { setCategory(e.target.value as 'stable' | 'random'); setDirty(true) }}
              options={[
                { value: 'stable', label: t('buffs.catStable') },
                { value: 'random', label: t('buffs.catRandom') },
              ]}
            />
            <Badge tone="neutral">{selected.key}</Badge>
            <Button onClick={save} disabled={!dirty}>
              <Icon name="check" size={14} />
              {t('buffs.save')}
            </Button>
          </div>

          <Card padded={false} className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <h2 className="text-sm font-semibold">{t('buffs.effect')}</h2>
              <span className="flex items-center gap-3">
                <span className="flex items-center gap-1 text-xs text-text-secondary">
                  <Icon name="edit" size={12} aria-hidden />
                  {t('briefs.raw')}
                </span>
                <span className="flex items-center gap-1 text-xs text-text-secondary">
                  <Icon name="eye" size={12} aria-hidden />
                  {t('briefs.preview')}
                </span>
                <span className="text-xs text-text-disabled">{t('buffs.charCount', { count: effect.length })}</span>
              </span>
            </div>
            <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-2">
              <textarea
                value={effect}
                onChange={(e) => { setEffect(e.target.value); setDirty(true) }}
                spellCheck={false}
                className="min-h-0 resize-none overflow-y-auto bg-transparent p-3 font-mono text-sm leading-relaxed text-text-primary outline-none placeholder:text-text-disabled"
                placeholder={polarity === 'debuff' ? t('buffs.debuffPlaceholder') : t('buffs.effectPlaceholder')}
              />
              <div className="min-h-0 overflow-y-auto border-t border-border p-3 md:border-l md:border-t-0">
                <div className="md-body">
                  <ReactMarkdown>{effect || (polarity === 'debuff' ? t('buffs.debuffPlaceholder') : t('buffs.effectPlaceholder'))}</ReactMarkdown>
                </div>
              </div>
            </div>
          </Card>

          <div className="flex flex-col gap-1.5">
            <h3 className="text-[10px] font-semibold uppercase tracking-wide text-text-disabled">
              {t('buffs.listHint')}
            </h3>
            <div className="flex flex-wrap gap-1.5">
              {stable.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => onSelect(b.id)}
                  className={`border px-2 py-1 text-xs transition-colors ${
                    selectedId === b.id
                      ? 'border-primary bg-primary/10 text-text-primary'
                      : 'border-border text-text-secondary hover:border-primary hover:text-primary'
                  }`}
                >
                  {b.name}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
